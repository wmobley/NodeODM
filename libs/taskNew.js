/*
NodeODM App and REST API to access ODM.
Copyright (C) 2016 NodeODM Contributors

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/

const multer = require('multer');
const fs = require('fs');
const path = require('path');
const TaskManager = require('./TaskManager');
const uuidv4 = require('uuid/v4');
const config = require('../config.js');
const rmdir = require('rimraf');
const Directories = require('./Directories');
const mv = require('mv');
const Task = require('./Task');
const async = require('async');
const odmInfo = require('./odmInfo');
const request = require('request');
const ziputils = require('./ziputils');
const statusCodes = require('./statusCodes');
const logger = require('./logger');

const download = function(uri, filename, callback) {
    request.head(uri, function(err, res, body) {
        if (err) callback(err);
        else{
            request(uri).pipe(fs.createWriteStream(filename)).on('close', callback);
        }
    });
};

const removeDirectory = function(dir, cb = () => {}){
    fs.stat(dir, (err, stats) => {
        if (!err && stats.isDirectory()) rmdir(dir, cb); // ignore errors, don't wait
        else cb(err);
    });
};

const assureUniqueFilename = (dstPath, filename, cb) => {
    const dstFile = path.join(dstPath, filename);
    fs.exists(dstFile, exists => {
        if (!exists) cb(null, filename);
        else{
            const parts = filename.split(".");
            if (parts.length > 1){
                assureUniqueFilename(dstPath, 
                    `${parts.slice(0, parts.length - 1).join(".")}_.${parts[parts.length - 1]}`, 
                    cb);
            }else{
                // Filename without extension? Strange..
                assureUniqueFilename(dstPath, filename + "_", cb);
            }
        }
    });
};

const getImportPathField = (body = {}) => {
    if (!body) return null;
    return body.import_path || body.importPath || null;
};

const isAbsoluteRoot = (rootPath) => {
    const parsed = path.parse(rootPath);
    return parsed.root === rootPath;
};

const normalizeImportPath = (rawPath) => {
    if (!rawPath) return { path: null };
    const trimmed = String(rawPath).trim();
    if (!trimmed) return { error: 'import_path cannot be empty.' };

    const allowedRoots = (config.importPathRoots || [])
        .filter(Boolean)
        .map(root => path.resolve(root));

    if (allowedRoots.length === 0) {
        return { error: 'import_path support is not configured on this node.' };
    }

    const resolved = path.resolve(trimmed);
    const withinAllowed = allowedRoots.some(root => {
        if (isAbsoluteRoot(root)) {
            return resolved.startsWith(root);
        }
        const normalizedRoot = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
        return resolved === root || resolved.startsWith(normalizedRoot);
    });

    if (!withinAllowed) {
        return { error: `Import path ${resolved} is not allowed on this node.` };
    }

    try {
        const stats = fs.statSync(resolved);
        if (!stats.isDirectory()) {
            return { error: `Import path ${resolved} must be a directory.` };
        }
    } catch (err) {
        return { error: `Import path ${resolved} cannot be accessed (${err.message}).` };
    }

    return { path: resolved };
};

const IMAGE_REGEX = /\.(jpe?g|png|gif|bmp|tiff?)$/i;

const estimateImagesInDir = (dirPath, cb) => {
    fs.readdir(dirPath, (err, entries) => {
        if (err) {
            cb(err, 0);
            return;
        }
        let count = 0;
        entries.forEach(entry => {
            if (IMAGE_REGEX.test(entry)) count++;
        });
        cb(null, count);
    });
};

const copySupportFiles = (srcDir, dstDir, cb) => {
    fs.readdir(srcDir, (err, entries) => {
        if (err) return cb(err);

        async.eachSeries(entries, (entry, done) => {
            if (/\.txt$/gi.test(entry) || /^align\.(las|laz|tif)$/gi.test(entry)) {
                const srcFile = path.join(srcDir, entry);
                const dstFile = path.join(dstDir, entry);

                fs.copyFile(srcFile, dstFile, err => {
                    if (err && err.code !== 'EEXIST') return done(err);
                    return done();
                });
            } else done();
        }, cb);
    });
};

const preserveSeedZipEnv = process.env.NODEODM_PRESERVE_SEED_ZIP;
const shouldPreserveSeedZips = !!preserveSeedZipEnv &&
    preserveSeedZipEnv !== '0' &&
    preserveSeedZipEnv.toLowerCase() !== 'false';

function logSeedExtractionSummary(projectPath, uuid) {
    fs.readdir(projectPath, (err, entries) => {
        if (err) {
            logger.warn(`[SEED DEBUG] Unable to list ${projectPath} after extracting seed for ${uuid}: ${err.message}`);
            return;
        }
        const preview = entries.slice(0, 15).join(', ');
        logger.info(`[SEED DEBUG] Seed extraction for ${uuid} produced ${entries.length} top-level entries${preview ? `: ${preview}` : ''}`);
        if (!entries.length) {
            logger.warn(`[SEED DEBUG] Seed extraction for ${uuid} appears empty; investigate seed.zip contents or upload path.`);
        }
    });
}

const upload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => {
            let dstPath = path.join("tmp", req.id);
            fs.exists(dstPath, exists => {
                if (!exists) {
                    fs.mkdir(dstPath, undefined, () => {
                        cb(null, dstPath);
                    });
                } else {
                    cb(null, dstPath);
                }
            });
        },
        filename: (req, file, cb) => {
            let filename = file.originalname;
            if (filename === "body.json") filename = "_body.json";

            let dstPath = path.join("tmp", req.id);
            assureUniqueFilename(dstPath, filename, cb);
        }
    })
});

module.exports = {
    assignUUID: (req, res, next) => {
        // A user can optionally suggest a UUID instead of letting
        // nodeODM pick one.
        if (req.get('set-uuid')){
            const userUuid = req.get('set-uuid');
    
            // Valid UUID and no other task with same UUID?
            if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-7][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(userUuid) && !TaskManager.singleton().find(userUuid)){
                req.id = userUuid;
                next();
            }else{
                res.json({error: `Invalid set-uuid: ${userUuid}`})
            }
        }else{
            req.id = uuidv4();
            next();
        }
    },

    getUUID: (req, res, next) => {
        req.id = req.params.uuid;
        if (!req.id) res.json({error: `Invalid uuid (not set)`});

        const srcPath = path.join("tmp", req.id);
        const bodyFile = path.join(srcPath, "body.json");

        fs.access(bodyFile, fs.F_OK, err => {
            if (err) res.json({error: `Invalid uuid (not found)`});
            else next();
        });
    },

    preUpload: (req, res, next) => {
        // Testing stuff
        if (!config.test) next();
        else{
            if (config.testDropUploads){
                if (Math.random() < 0.5) res.sendStatus(500);
                else next();
            }else{
                next();
            }
        }
    },

    uploadImages: upload.array("images"),

    handleUpload: (req, res) => {
        // IMPROVEMENT: check files count limits ahead of handleTaskNew
        if (req.files && req.files.length > 0){
            res.json({success: true});
        }else{
            res.json({error: "Need at least 1 file.", noRetry: true});
        }
    },

    handleCommit: (req, res, next) => {
        const srcPath = path.join("tmp", req.id);
        const bodyFile = path.join(srcPath, "body.json");

        async.series([
            cb => {
                fs.readFile(bodyFile, 'utf8', (err, data) => {
                    if (err) cb(err);
                    else{
                        try{
                            const body = JSON.parse(data);
                            fs.unlink(bodyFile, err => {
                                if (err) cb(err);
                                else cb(null, body);
                            });
                        }catch(e){
                            cb(new Error("Malformed body.json"));
                        }
                    }
                });
            },
            cb => fs.readdir(srcPath, cb),
        ], (err, [ body, files ]) => {
            if (err) res.json({error: err.message});
            else{
                req.body = body;
                req.files = files;

                const hasImportPath = !!getImportPathField(req.body);
                if (req.files.length === 0 && !hasImportPath && !req.body.zipurl){
                    req.error = "Need at least 1 file.";
                }
                next();
            }
        });
    },

    handleInit: (req, res) => {
        req.body = req.body || {};
        
        const srcPath = path.join("tmp", req.id);
        const bodyFile = path.join(srcPath, "body.json");

        // Print error message and cleanup
        const die = (error) => {
            res.json({error});
            removeDirectory(srcPath);
        };

        async.series([
            cb => {
                // Check for problems before file uploads
                if (req.body && req.body.options){
                    odmInfo.filterOptions(req.body.options, err => {
                        if (err) cb(err);
                        else cb();
                    });
                }else cb();
            },
            cb => {
                fs.stat(srcPath, (err, stat) => {
                    if (err && err.code === 'ENOENT') fs.mkdir(srcPath, undefined, cb);
                    else cb(); // Dir already exists
                });
            },
            cb => {
                fs.writeFile(bodyFile, JSON.stringify(req.body), {encoding: 'utf8'}, cb);
            },
            cb => {
                res.json({uuid: req.id});
                cb();
            }
        ],  err => {
            if (err) die(err.message);
        });
    },

    createTask: (req, res) => {
        const srcPath = path.join("tmp", req.id);
        const rawImportPath = getImportPathField(req.body);
        const hasUploadedFiles = Array.isArray(req.files) && req.files.length > 0;
        const hasZipUrl = !!req.body.zipurl;

        // Print error message and cleanup
        const die = (error) => {
            res.json({error});
            removeDirectory(srcPath);
        };
        
        let sharedImportPath = null;
        let useSharedImport = false;
        if (rawImportPath) {
            const result = normalizeImportPath(rawImportPath);
            if (result.error) {
                if (hasUploadedFiles || hasZipUrl) {
                    logger.warn(`Import path ${rawImportPath} rejected (${result.error}); falling back to uploaded data for task ${req.id}`);
                } else {
                    die(result.error);
                    return;
                }
            } else {
                sharedImportPath = result.path;
                useSharedImport = true;
                logger.info(`Using import_path ${sharedImportPath} for task ${req.id}`);
            }
        }
        
        let destPath = path.join(Directories.data, req.id);
        let destImagesPath = path.join(destPath, "images");
        let destGcpPath = path.join(destPath, "gcp");

        const checkMaxImageLimits = (cb) => {
            if (!config.maxImages) cb();
            else{
                fs.readdir(destImagesPath, (err, files) => {
                    if (err) cb(err);
                    else if (files.length > config.maxImages) cb(new Error(`${files.length} images uploaded, but this node can only process up to ${config.maxImages}.`));
                    else cb();
                });
            }
        };

        let initSteps;
        if (useSharedImport) {
            initSteps = [
                cb => {
                    fs.stat(destPath, (err) => {
                        if (err && err.code === 'ENOENT') return cb();
                        if (err) return cb(err);
                        removeDirectory(destPath, err => {
                            if (err) cb(new Error(`Directory exists and we couldn't remove it.`));
                            else cb();
                        });
                    });
                },
                cb => fs.mkdir(destPath, undefined, err => {
                    if (err && err.code !== 'EEXIST') cb(err);
                    else cb();
                }),
                cb => fs.mkdir(destGcpPath, undefined, err => {
                    if (err && err.code !== 'EEXIST') cb(err);
                    else cb();
                }),
                cb => fs.symlink(sharedImportPath, destImagesPath, 'dir', err => {
                    if (err && err.code === 'EEXIST') {
                        fs.unlink(destImagesPath, unlinkErr => {
                            if (unlinkErr) cb(unlinkErr);
                            else fs.symlink(sharedImportPath, destImagesPath, 'dir', cb);
                        });
                    } else cb(err);
                }),
                cb => {
                    checkMaxImageLimits(cb);
                },
                cb => copySupportFiles(sharedImportPath, destGcpPath, err => {
                    if (err && err.code !== 'ENOENT') return cb(err);
                    cb();
                })
            ];
        } else {
            initSteps = [
            // Check if dest directory already exists
            cb => {
                if (req.files && req.files.length > 0) {
                    fs.stat(destPath, (err, stat) => {
                        if (err && err.code === 'ENOENT') cb();
                        else{
                            // Directory already exists, this could happen
                            // if a previous attempt at upload failed and the user
                            // used set-uuid to specify the same UUID over the previous run
                            // Try to remove it
                            removeDirectory(destPath, err => {
                                if (err) cb(new Error(`Directory exists and we couldn't remove it.`));
                                else cb();
                            });
                        } 
                    });
                } else {
                    cb();
                }
            },

            // Unzips zip URL to tmp/<uuid>/ (if any)
            cb => {
                if (req.body.zipurl) {
                    let archive = "zipurl.zip";

                    upload.storage.getDestination(req, archive, (err, dstPath) => {
                        if (err) cb(err);
                        else{
                            let archiveDestPath = path.join(dstPath, archive);

                            download(req.body.zipurl, archiveDestPath, cb);
                        }
                    });
                } else {
                    cb();
                }
            },
            
            // Move all uploads to data/<uuid>/images dir (if any)
            cb => fs.mkdir(destPath, undefined, err => {
                if (!err) {
                    logger.info(`[SEED DEBUG] Created project directory ${destPath}`);
                } else if (err.code === 'EEXIST') {
                    logger.info(`[SEED DEBUG] Project directory ${destPath} already exists`);
                    err = null;
                }
                cb(err);
            }),
            cb => fs.mkdir(destGcpPath, undefined, err => {
                if (!err) {
                    logger.info(`[SEED DEBUG] Created gcp directory ${destGcpPath}`);
                } else if (err.code === 'EEXIST') {
                    logger.info(`[SEED DEBUG] GCP directory ${destGcpPath} already exists`);
                    err = null;
                }
                cb(err);
            }),
            cb => {
                // We attempt to do this multiple times,
                // as antivirus software sometimes is scanning
                // the folder while we try to move it, resulting in
                // an operation not permitted error
                let retries = 0;

                const move = () => {
                    logger.info(`[SEED DEBUG] Moving uploads from ${srcPath} to ${destImagesPath}`);
                    mv(srcPath, destImagesPath, err => {
                        if (!err) cb(); // Done
                        else{
                            if (++retries < 20){
                                logger.warn(`Cannot move ${srcPath}, probably caused by antivirus software (please disable it or add an exception), retrying (${retries})...`);
                                setTimeout(move, 2000);
                            } else {
                                logger.error(`Unable to move temp images (${srcPath}) after 20 retries. Error: ${err}`);
                                cb(err);
                            }
                        }
                    });
                }
                move();
            },
            // Zip files handling
            cb => {
                const handleSeed = (cb) => {
                    logger.info(`[SEED DEBUG] Entering seed handler for task ${req.id} (project ${destPath})`);
                    const seedFileDst = path.join(destPath, "seed.zip");
                    const seedSource = path.join(destImagesPath, "seed.zip");

                    async.series([
                        // Move to project root
                        cb => {
                            logger.info(`[SEED DEBUG] Moving seed archive from ${seedSource} to ${seedFileDst}`);
                            mv(seedSource, seedFileDst, cb);
                        },

                        // Optionally keep a copy for debugging
                        cb => {
                            if (!shouldPreserveSeedZips) return cb();
                            const debugCopyPath = path.join(destPath, `seed-${req.id}.zip`);
                            fs.copyFile(seedFileDst, debugCopyPath, err => {
                                if (err) {
                                    logger.warn(`[SEED DEBUG] Failed to copy seed.zip for ${req.id}: ${err.message}`);
                                } else {
                                    logger.info(`[SEED DEBUG] Preserved seed archive at ${debugCopyPath}`);
                                }
                                cb();
                            });
                        },
                        
                        // Extract
                        cb => {
                            logger.info(`[SEED DEBUG] Unzipping ${seedFileDst} for task ${req.id} into ${destPath}`);
                            ziputils.unzip(seedFileDst, destPath, err => {
                                if (err) {
                                    logger.warn(`[SEED DEBUG] unzip failed for ${req.id}: ${err.message}`);
                                } else {
                                    logSeedExtractionSummary(destPath, req.id);
                                }
                                cb(err);
                            });
                        },

                        // Remove
                        cb => {
                            fs.exists(seedFileDst, exists => {
                                if (exists) {
                                    logger.info(`[SEED DEBUG] Removing temporary seed archive ${seedFileDst}`);
                                    fs.unlink(seedFileDst, cb);
                                }
                                else cb();
                            });
                        }
                    ], cb);
                }

                const handleZipUrl = (cb) => {
                    // Extract images
                    ziputils.unzip(path.join(destImagesPath, "zipurl.zip"), 
                                    destImagesPath, 
                                    cb, true);
                }

                // Find and handle zip files and extract
                fs.readdir(destImagesPath, (err, entries) => {
                    if (err) cb(err);
                    else {
                        async.eachSeries(entries, (entry, cb) => {
                            if (entry === "seed.zip"){
                                logger.info(`[SEED DEBUG] Found seed.zip in ${destImagesPath}`);
                                handleSeed(cb);
                            }else if (entry === "zipurl.zip") {
                                logger.info(`[SEED DEBUG] Found zipurl.zip in ${destImagesPath}`);
                                handleZipUrl(cb);
                            } else cb();
                        }, cb);
                    }
                });
            },

            // Verify max images limit
            cb => {
                checkMaxImageLimits(cb);
            },

            cb => {
                // Find any *.txt (GCP) file or alignment file and move it to the data/<uuid>/gcp directory
                // also remove any lingering zipurl.zip
                fs.readdir(destImagesPath, (err, entries) => {
                    if (err) cb(err);
                    else {
                        async.eachSeries(entries, (entry, cb) => {
                            if (/\.txt$/gi.test(entry) || /^align\.(las|laz|tif)$/gi.test(entry)) {
                                mv(path.join(destImagesPath, entry), path.join(destGcpPath, entry), cb);
                            }else if (/\.zip$/gi.test(entry)){
                                fs.unlink(path.join(destImagesPath, entry), cb);
                            } else cb();
                        }, cb);
                    }
                });
            }
        ];
        }

        if (req.error !== undefined){
            die(req.error);
        }else{
            let imagesCountEstimate = -1;

            async.series([
                cb => {
                    // Basic path check
                    if (useSharedImport) return cb();
                    fs.exists(srcPath, exists => {
                        if (exists) cb();
                        else cb(new Error(`Invalid UUID`));
                    });
                },
                cb => {
                    odmInfo.filterOptions(req.body.options, (err, options) => {
                        if (err) cb(err);
                        else {
                            req.body.options = options;
                            cb(null);
                        }
                    });
                },
                cb => {
                    const targetDir = useSharedImport ? sharedImportPath : srcPath;
                    estimateImagesInDir(targetDir, (err, count) => {
                        if (!err) imagesCountEstimate = count;
                        cb();
                    });
                },
                cb => {
                    const task = new Task(req.id, req.body.name, req.body.options,
                            req.body.webhook,
                            req.body.skipPostProcessing === 'true',
                            req.body.outputs,
                            req.body.dateCreated,
                            imagesCountEstimate
                        );
                    TaskManager.singleton().addNew(task);
                    res.json({ uuid: req.id });
                    cb();

                    // We return a UUID right away but continue
                    // doing processing in the background

                    task.initialize(err => {
                        if (err) {
                            // Cleanup
                            logger.error(`Task initialization failed for ${req.id}: ${err.message}`);
                            if (err.stack) logger.error(err.stack);
                            removeDirectory(srcPath);
                            logger.warn(`Task initialization failed for ${req.id}; preserving ${destPath} for debugging.`);
                        } else TaskManager.singleton().processNextTask();
                    }, initSteps);
                }
            ], err => {
                if (err) die(err.message);
            });
        }
    }
}
