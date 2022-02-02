const path = require('path');
const {createWriteStream} = require('fs');
const fs = require('fs').promises;
const util = require('util');

const {readWantedLockfile} = require( '@pnpm/lockfile-file');
const {filterLockfileByImporters} = require('@pnpm/filter-lockfile');
const {nameVerFromPkgSnapshot} = require('@pnpm/lockfile-utils');
const getConfig = require('@pnpm/config').default;
const dp = require('dependency-path');
const tar = require('tar-stream');
const packageJson = require('@pnpm/read-package-json');
const packlist = require('npm-packlist');

// Rate limited fs operation (to avod too many open files)
const { readlink, readdir, stat, readFile } = (() => {
  const async = require('async');
  const queue = async.queue(async (fun) => {
    return fun();
  }, 1000);

  const push = util.promisify(queue.push.bind(queue));

  return {
    stat: (file) => {
      return push(() => {
        return fs.stat(file);
      })
    },
    readlink: (file) => {
      return push(() => {
        return fs.readlink(file);
      })
    },
    readdir: (file, opts) => {
      return push(() => {
        return fs.readdir(file, opts);
      });
    },
    readFile: (file) => {
      return push(() => {
        return fs.readFile(file);
      });
    }
  }
})();

/**
 * List all the files in currentDir realtive to baseDir.
 * Symlinks are listed as is, and not followed.
 */
const listAllFiles = async (baseDir, currentDir, isModuleRoot = true) => {
  const fullCurrentDir = path.join(baseDir, currentDir);

  if(isModuleRoot){
    // Starting point. If it's itself a link, we don't want to list it
    const fullCurrentDirPath = path.join(baseDir, currentDir);
    const currentDirStat = await stat(fullCurrentDirPath);

    if(currentDirStat.isSymbolicLink()){
      return readlink(fullSubDirPath).then((link) => {
        return {
          type:'link',
          path: fullCurrentDirPath,
          target: link
        };
      });
    }
  }

  const subDirs = await readdir(fullCurrentDir, {withFileTypes: true});

  return Promise.all(subDirs.map((sub) => {
    const subDirPath = path.join(currentDir, sub.name);
    const fullSubDirPath = path.join(baseDir, subDirPath);

    if(sub.isFile()){
      return Promise.resolve({
        type:'file',
        path: subDirPath,
        target: fullSubDirPath
      });
    } else if(sub.isSymbolicLink()){
      return readlink(fullSubDirPath).then((link) => {
        return {
          type:'link',
          path: subDirPath,
          target: link
        };
      });
    } else{
      // a directory
      return listAllFiles(baseDir, subDirPath, false)
    }
  })).then(r => r.flat())
};

/**
 * Given the importers to include, list the files and links to add to the tar
 */
const listAllFilesForImporters = async (importers) => {
  const filesToCreate = [];
  for(const [importerId, importer] of Object.entries(importers)){
    // copy all the fles that are referenced by the package.json, and not excluded, etc
    const packListFiles = await packlist({path : importer.source});
    for(const packListFile of packListFiles){
      const tarPath = path.join(importer.fullPath, packListFile);
      const target = path.join(importer.source, packListFile);
      if(tarPath === 'package.json'){
        // special case for the main package.json
        // we remove the dependencies properties as we bundled everything
        const content = await packageJson.safeReadPackage(target);
        delete content.dependencies;
        content.bundledDependencies = true;
        filesToCreate.push({
          type: 'file',
          path: tarPath,
          content: Buffer.from(JSON.stringify(content, null, 4), 'utf-8')
        });
      } else {
        filesToCreate.push({
          type: 'file',
          path: tarPath,
          target
        });
      }
    };

    // add symlink to all dependencies
    for(const [depName, depTarget] of Object.entries(importer.dependencies)){
        filesToCreate.push({
          type: 'link',
          path: path.join(importer.nodeModules, depName),
          target: depTarget.relativePath
        });
    }
  }
  return filesToCreate;
}

/**
 * Take a list of files a returned by listAllfiles and put everythink in a tar file
 * (keeping all symlinks)
 */
const buildTarFile = async (files, tarFileName) => {
  const pack = tar.pack();
  const addEntry = util.promisify(pack.entry.bind(pack))

  const writeAllFiles = files.map((file) => {
    // move everything under package/
    const pathInTar = path.join('package', file.path);

    if(file.type === 'file'){
      if(file.content){
        return addEntry({ name: pathInTar }, file.content);
      } else {
        return readFile(file.target).then((content) => {
          return addEntry({ name: pathInTar }, content);
        })
      }
    } else if(file.type === 'link'){
      return addEntry({ name: pathInTar, type: 'symlink', linkname: file.target });
    }
    return Promise.resolve(null);
  });

  const output = createWriteStream(tarFileName);
  pack.pipe(output);

  await Promise.all(writeAllFiles).then(() => pack.finalize());

  return new Promise((resolve, reject) => {
    output.on('close', () => {
      resolve();
    });
    output.on('error', (error) => {
      reject(error);
    });
  });
};


const depPathForImporter = (importer) => {
  // hacking to get a name that looks good :)
  return dp.depPathToFilename('file:' + importer, '.');
}

/**
 * Find all local dependencies (importers)
 */
const findAllImporters = async(lockFile, mainImporterId, config) => {
  const importers = {};
  importers[mainImporterId] = {
    dependencies: {}, // initially we haven't filled the dependency, we need to put this importer in the queue
    source: path.join(config.lockfileDir, mainImporterId), // where the code is in the repo
    nodeModules: 'node_modules', // the path (in the tar) where to put the node_modules
    fullPath: '.' // the path (in the tar) where to put this module code
  };

  const importerIdQueue = [mainImporterId];

  while(importerIdQueue.length >= 1){
    const importerId = importerIdQueue.pop();
    const dependencies = lockFile.importers[importerId].dependencies || {};

    for([depName, depPath] of Object.entries(dependencies)){
      if(depPath.startsWith('link:')){
        // internal dependency (to another importer)
        const newImporterId = path.join(importerId, depPath.slice(5)); // resolve the name of this importer compared to current importer
        const newImporterSource = path.join(config.lockfileDir, newImporterId);
        const newImporterManifest = await packageJson.fromDir(newImporterSource);
        const newImporterVirtualNodeModules = path.join(config.virtualStoreDir, depPathForImporter(newImporterId), 'node_modules');
        const newImporterFullVirtualPath = path.join(newImporterVirtualNodeModules, newImporterManifest.name);

        if(!importers[newImporterId]){
          // we never handled this importer, let's do it!
          importers[newImporterId] = {
            dependencies: {},
            source: newImporterSource,
            nodeModules: newImporterVirtualNodeModules,
            fullPath: newImporterFullVirtualPath
          };
          importerIdQueue.push(newImporterId); // put in the queue to fill the dependencies
        }

        // set this dependency as a relative path to the dependency full path
        importers[importerId].dependencies[depName] = {
          type: 'importer',
          relativePath: path.relative(path.join(importers[importerId].nodeModules, depName, '..'), newImporterFullVirtualPath)
        };
      } else {
        // external dependency (to a module in npm registry)

        // sometimes the depPath is a reference to the dependency name (starts with "/") sometimes it's a version.
        const depRef = depPath.indexOf('/') === 0 ? depPath : `/${depName}/${depPath}`
        const realDepName = nameVerFromPkgSnapshot(depRef, lockFile).name;
        const depFullVirtualPath = path.join(config.virtualStoreDir, dp.depPathToFilename(depRef, config.lockfileDir), 'node_modules', realDepName);
        importers[importerId].dependencies[depName] = {
          type: 'package',
          relativePath: path.relative(path.join(importers[importerId].nodeModules, depName, '..'), depFullVirtualPath)
        };
      }
    }
  }

  return importers;
};

/**
 * Main
 */
const main = async (workspaceDir, importerId, outputFile) => {
  const { config } = await getConfig({
    cliOptions: {},
    workspaceDir
  });

  const lockFile = await readWantedLockfile(config.lockfileDir, {});

  const importers = await findAllImporters(lockFile, importerId, config);
  const importerIds = Object.keys(importers);

  const lockFileForImporters = filterLockfileByImporters(lockFile, importerIds, {
    skipped: new Set(),
    include: {
      dependencies: true,
      devDependencies: false, // only prod dependencies
      optionalDependencies: true
    },
    failOnMissingDependencies: true
  });


  const packageIds = Object.keys(lockFileForImporters.packages);
  const packagesPaths = packageIds.map((depPath) => {
    return path.join(config.virtualStoreDir, dp.depPathToFilename(depPath, config.lockfileDir))
  });

  const packageFiles = Promise.all(packagesPaths.map((path) => listAllFiles(workspaceDir, path))).then(p => p.flat());
  const importerFiles = listAllFilesForImporters(importers);

  const allFiles = (await packageFiles).concat(await importerFiles);

  return buildTarFile(allFiles, outputFile);
}

// RUN
const workspaceDir = process.argv[2];
const mainImporterId = process.argv[3] || '.';
main(workspaceDir, mainImporterId, 'out.tar').catch((error) => {
  console.error(error);
  process.exit(1);
});
