/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import * as proto from '../protocol';
import {OmnisharpServer} from '../omnisharpServer';
import findLaunchTargets from '../launchTargetFinder';
import * as pathHelpers from '../pathHelpers';
import {runInTerminal} from 'run-in-terminal';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

const isWin = /^win/.test(process.platform);

export default function registerCommands(server: OmnisharpServer, extensionPath: string) {
	let d1 = vscode.commands.registerCommand('o.restart', () => server.restart());
	let d2 = vscode.commands.registerCommand('o.pickProjectAndStart', () => pickProjectAndStart(server));
	let d3 = vscode.commands.registerCommand('o.restore', () => dnxRestoreForAll(server));
	let d4 = vscode.commands.registerCommand('o.execute', () => dnxExecuteCommand(server));
	let d5 = vscode.commands.registerCommand('o.execute-last-command', () => dnxExecuteLastCommand(server));
	let d6 = vscode.commands.registerCommand('o.showOutput', () => server.getChannel().show(vscode.ViewColumn.Three));
    let d7 = vscode.commands.registerCommand('dotnet.restore', () => dotnetRestore(server)); 
    let d8 = vscode.commands.registerCommand('csharp.addTasksJson', () => addTasksJson(server, extensionPath));
    
	return vscode.Disposable.from(d1, d2, d3, d4, d5, d6, d7, d8);
}

function pickProjectAndStart(server: OmnisharpServer) {

	return findLaunchTargets().then(targets => {

		let currentPath = server.getSolutionPathOrFolder();
		if (currentPath) {
			for (let target of targets) {
				if (target.target.fsPath === currentPath) {
					target.label = `\u2713 ${target.label}`;
				}
			}
		}

		return vscode.window.showQuickPick(targets, {
			matchOnDescription: true,
			placeHolder: `Select 1 of ${targets.length} projects`
		}).then(target => {
			if (target) {
				return server.restart(target.target.fsPath);
			}
		});
	});
}

interface Command {
	label: string;
	description: string;
	execute(): Thenable<any>;
}

let lastCommand: Command;

function dnxExecuteLastCommand(server: OmnisharpServer) {
	if (lastCommand) {
		lastCommand.execute();
	} else {
		dnxExecuteCommand(server);
	}
}

function dnxExecuteCommand(server: OmnisharpServer) {

	if (!server.isRunning()) {
		return Promise.reject('OmniSharp server is not running.');
	}

	return server.makeRequest<proto.WorkspaceInformationResponse>(proto.Projects).then(info => {

		let commands: Command[] = [];

		info.Dnx.Projects.forEach(project => {
			Object.keys(project.Commands).forEach(key => {

				commands.push({
					label: `dnx ${key} - (${project.Name || path.basename(project.Path)})`,
					description: path.dirname(project.Path),
					execute() {
						lastCommand = this;

						let command = path.join(info.Dnx.RuntimePath, 'bin/dnx');
						let args = [key];

						// dnx-beta[1-6] needs a leading dot, like 'dnx . run'
						if (/-beta[1-6]/.test(info.Dnx.RuntimePath)) {
							args.unshift('.');
						}

						if (isWin) {
							command += '.exe';
						}

						return runInTerminal(command, args, {
							cwd: path.dirname(project.Path),
							env: {
								// KRE_COMPILATION_SERVER_PORT: workspace.DesignTimeHostPort
							}
						});
					}
				});
			});
		});

		return vscode.window.showQuickPick(commands).then(command => {
			if (command) {
				return command.execute();
			}
		});
	});
}

export function dnxRestoreForAll(server: OmnisharpServer) {

	if (!server.isRunning()) {
		return Promise.reject('OmniSharp server is not running.');
	}

	return server.makeRequest<proto.WorkspaceInformationResponse>(proto.Projects).then(info => {

		let commands:Command[] = [];

		info.Dnx.Projects.forEach(project => {
			commands.push({
				label: `dnu restore - (${project.Name || path.basename(project.Path)})`,
				description: path.dirname(project.Path),
				execute() {

					let command = path.join(info.Dnx.RuntimePath, 'bin/dnu');
					if (isWin) {
						command += '.cmd';
					}

					return runInTerminal(command, ['restore'], {
						cwd: path.dirname(project.Path)
					});
				}
			});
		});

		return vscode.window.showQuickPick(commands).then(command => {
			if(command) {
				return command.execute();
			}
		});
	});
}

export function dnxRestoreForProject(server: OmnisharpServer, fileName: string) {

	return server.makeRequest<proto.WorkspaceInformationResponse>(proto.Projects).then((info):Promise<any> => {
		for(let project of info.Dnx.Projects) {
			if (project.Path === fileName) {
				let command = path.join(info.Dnx.RuntimePath, 'bin/dnu');
				if (isWin) {
					command += '.cmd';
				}

				return runInTerminal(command, ['restore'], {
					cwd: path.dirname(project.Path)
				});
			}
		}

		return Promise.reject(`Failed to execute restore, try to run 'dnu restore' manually for ${fileName}.`)
	});
}

function dotnetRestore(server: OmnisharpServer) {

    if (!server.isRunning()) {
        return Promise.reject('OmniSharp server is not running.');
    }

    let solutionPathOrFolder = server.getSolutionPathOrFolder();
    if (!solutionPathOrFolder) {
        return Promise.reject('No solution or folder open.');
    }

    pathHelpers.getPathKind(solutionPathOrFolder).then(kind => {
        if (kind === pathHelpers.PathKind.File) {
            return path.dirname(solutionPathOrFolder);
        }
        else {
            return solutionPathOrFolder;
        }
    }).then((solutionDirectory) => {
        return runInTerminal('dotnet', ['restore'], {
            cwd: solutionPathOrFolder
        });
    });
}

function ensureDirectoryCreated(directoryPath: string) {
    return pathHelpers.exists(directoryPath).then(e => {
        if (e) {
            return true;
        }
        else {
            return pathHelpers.mkdir(directoryPath);
        }
    });
}

function getExpectedVsCodeFolderPath(solutionPathOrFolder: string): Promise<string> {
    return pathHelpers.getPathKind(solutionPathOrFolder).then(kind => {
        if (kind === pathHelpers.PathKind.File) {
            return path.join(path.dirname(solutionPathOrFolder), '.vscode');
        }
        else {
            return path.join(solutionPathOrFolder, '.vscode');
        }
    });
}

export function addTasksJson(server: OmnisharpServer, extensionPath: string) {
    return new Promise<string>((resolve, reject) => {
        if (!server.isRunning()) {
            return reject('OmniSharp is not running.');
        }
        
        let solutionPathOrFolder = server.getSolutionPathOrFolder();
        if (!solutionPathOrFolder)
        {
            return reject('No solution or folder open.');
        }
        
        return getExpectedVsCodeFolderPath(solutionPathOrFolder).then(vscodeFolderPath => { 
            let tasksJsonPath = path.join(vscodeFolderPath, 'tasks.json');
            
            return pathHelpers.exists(tasksJsonPath).then(e => {
                if (e) {
                    return vscode.window.showInformationMessage(`${tasksJsonPath} already exists.`).then(_ => {
                        return resolve(tasksJsonPath);
                    });
                }
                else {
                    let templatePath = path.join(extensionPath, 'template-tasks.json');
                    
                    return pathHelpers.exists(templatePath).then(e => {
                        if (!e) {
                            return reject('Could not find template-tasks.json file in extension.');
                        }
                        
                        return ensureDirectoryCreated(vscodeFolderPath).then(ok => {
                            if (ok) {
                                let oldFile = fs.createReadStream(templatePath);
                                let newFile = fs.createWriteStream(tasksJsonPath);
                                oldFile.pipe(newFile);
                                
                                return resolve(tasksJsonPath);
                            }
                            else {
                                return reject(`Could not create ${vscodeFolderPath} directory.`);
                            }
                        });
                    });
                }
            });
        });
    });
}