#! /usr/bin/env node

'use strict';

const util = require('util');
const commandLineArgs = require('command-line-args');
const getUsage = require('command-line-usage');
const LatLon = require('geodesy').LatLonSpherical;

var fs = require('fs');
var logger = require('tru-logger');
var mkdirp = require('mkdirp');
var PokemonGoAPI = require('tru-pokemongo-api');

const optionDefinitions = [
	{
		header: 'Pokemon GO Bot',
		content: 'A bot to wander around collecting Pokemon and items'
	},
	{
		header: 'Options',
		optionList: [
			{
				name: 'loop',
				alias: 'l',
				type: Boolean,
				description: 'Do not have the process loop'
			}, {
				name: 'catch',
				alias: 'c',
				type: Boolean,
				description: 'Do not try to catch Pokemon; must be used with the loop (-l) flag'
			}, {
				name: 'scrap',
				alias: 's',
				type: Boolean,
				description: 'Do not scrap duplicate Pokemon (must have the "allow_scrap" parameter in the user config file)'
			}, {
				name: 'trash',
				alias: 't',
				type: Boolean,
				description: 'Do not trash items defined in user config file (trash_items parameter)'
			}, {
				name: 'inventory',
				alias: 'i',
				type: Boolean,
				description: 'Do not show inventory'
			}, {
				name: 'pokemon',
				alias: 'p',
				type: Boolean,
				description: 'Do not show Pokemon'
			}, {
				name: 'write',
				alias: 'w',
				type: Boolean,
				description: 'Do not write inventory to file in the ./inventory_files/{username}.json file'
			}, {
				name: 'deploy',
				alias: 'd',
				type: Boolean,
				description: 'Deploy to gyms and collect coins'
			}, {
				name: 'file',
				alias: 'f',
				type: String,
				typeLabel: '[underline]{filename}',
				description: 'Coordinates file to be written to the ./coord_files/ directory'
			}, {
				name: 'begin',
				alias: 'b',
				type: String,
				typeLabel: '[underline]{beginning coordinates}',
				description: 'Coordinates from which to start and build a path (in the format lat,lon)'
			}, {
				name: 'username',
				alias: 'u',
				type: String,
				defaultOption: true,
				typeLabel: '[underline]{username}',
				description: 'User account to idle (matches against a filename in the ./configs/ directory)'
			}
		]
	}
];

function showUsage(msg) {
	if(msg != null) {
		console.log(msg);
	}
	const usage = getUsage(optionDefinitions);
	console.log(usage);
	process.exit();
}

var flags = commandLineArgs(optionDefinitions[1].optionList);

var doLoop = !flags.loop;
var doCatch = !flags.catch;
var doDeploy = flags.deploy || false;
var doScrap = !flags.scrap;
var doTrash = !flags.trash;
var doShowInventory = !flags.inventory;
var doShowPokemon = !flags.pokemon;
var doWriteInventory = !flags.write;

var username = flags.username;
var coords_filename = flags.file;

if(username == null) {
	showUsage("You must provide a username (-u)");
}

if(doCatch && !doLoop) {
	showUsage("The catch (-c) flag must be used with the loop flag (-l)");
}

// using var so you can login with multiple users
var pokeAPI = new PokemonGoAPI();

var pokemon_name_max_len = 0;

for(var i in pokeAPI.pokemonlist) {
	if(pokeAPI.pokemonlist[i].name.length > pokemon_name_max_len) {
		pokemon_name_max_len = pokeAPI.pokemonlist[i].name.length;
	}
}

if(coords_filename !== undefined) {
	if(coords_filename != null) {
		var coordFilesDir = __dirname + "/coord_files/";
		var coords_file = coordFilesDir + coords_filename;
		mkdirp(coordFilesDir, function(err) {
			// path was created unless there was error
			if(err) {
				throw "Unable to create coord files dir: " + coordFilesDir;
			}

			var header = "lat,lon,name";
			fs.appendFile(coords_file, header + "\n", function(err) {
				if(err) throw err;
			});
		});
	} else {
		showUsage("You must provide a filename with the write flag (-f)");
	}
}

// config files
var configsDir = __dirname + "/configs";
var accountConfigFile = configsDir + "/" + username + ".json";
var account_config = [];

if(doWriteInventory) {
	var inventoryFilesDir = __dirname + "/inventory_files/";
	var inventory_file = inventoryFilesDir + username + ".json";
	mkdirp(inventoryFilesDir, function(err) {
		// path was created unless there was error
		if(err) {
			throw "Unable to create inventory files dir: " + inventoryFilesDir;
		}
	});
}

// account config
if(fs.existsSync(accountConfigFile)) {
	var data = fs.readFileSync(accountConfigFile, 'utf8');
	if(data != undefined) {
		account_config = JSON.parse(data);
	} else {
		throw Error("MISTAKE: there was a problem reading the config file: " + accountConfigFile);
	}
} else {
	throw Error("MISTAKE: configFile does not exist: " + accountConfigFile);
}

var logDir = __dirname + "/logs/";
mkdirp(logDir, function(err) {
	// path was created unless there was error
	if(err) {
		throw "Unable to create log dir: " + logDir;
	}
});

// initialize log
var logOptions = {
	file: logDir + account_config.username + ".txt",
	date: true,
	print: true,
	log_level: ["all"]/*,
	 prefix: account_config.username*/
};

var myLog = new logger(logOptions);

var username = process.env.PGO_USERNAME || account_config.username;
var password = process.env.PGO_PASSWORD || account_config.password;
var provider = process.env.PGO_PROVIDER || account_config.provider;

var allow_scrap = account_config.allow_scrap || false;
var trash_items = account_config.trash_items || null;

var interval_obj;
var interval_min = 15000;
var interval_max = 25000;
var interval;

var retry_wait = 10000;
var call_wait = 2500;

var min_catch_probability = 30;

var poke_storage = 0;
var item_storage = 0;

var nothing_nearby_count = 0;
var nothing_nearby_max = 15;

var pokeball_counts = [];
var inventory_items = [];
var items_to_trash = [];
var incubators = [];
var eggs = [];
var hatched_pokemon = [];

var player_profile;

var deploy_collect = false;

var pokemon_list = [];
var pokemon_grouped = [];
var best_pokemon = {};
var add_to_favorites = [];
var pokemon_to_scrap = [];

var break_loop = false;
var stop_process = false;
var take_break = false;
var num_loop = 0;
var num_loops = 1;

var restart_wait_min = 30; // in minutes
var restart_wait_max = 90; // in minutes
var fail_count_restart = 0;

var breaktime = null;
var loop_time_min = 60; // in minutes
var loop_time_max = 120; // in minutes

var perfect_score = (15 + 15 + 15);

var max_dist = 40;
var max_walk_dist = 20;

var fail_count = 0;

var award_num = 0;

var current_location = -1;
var locations = [];
var forts_in_path = [];
var location_num = 0;
var total_distance = null;

var player_stats = null;

var begin = null;
if(flags.begin !== undefined && flags.begin != null) {
	begin = flags.begin.split(",");
}
var start_point = begin || account_config.start_point;
var location = configCoords(start_point);
var start_location_num = null;
var closest_to_start = null;

init();

function init() {
	var init_options = {
		username: username,
		password: password,
		location: location,
		provider: provider,
		collect: deploy_collect
	};
	pokeAPI.init(init_options, function(err, responses) {
		if(err) {
			fail_count_restart++;
			if(fail_count_restart <= 10) {
				myLog.error("From main:");
				myLog.error(err);
				myLog.error("Wait " + (retry_wait / 1000) + " seconds between retries");
				// wait between tries
				setTimeout(function() {
					init();
				}, retry_wait);
				return;
			} else {
				myLog.attention("Stopping process - failed to start/restart");
				return;
			}
		} else {
			processHeartBeatResponses(responses, function() {
				if(locations.length <= 0) {
					if(responses.GET_MAP_OBJECTS !== undefined && responses.GET_MAP_OBJECTS.map_cells !== undefined) {
						processGetMapObjectsResponse(responses.GET_MAP_OBJECTS, function() {
							if(forts_in_path.length > 0) {
								myLog.chat(forts_in_path.length + " Forts in this path");
								getPath({locations: forts_in_path}, function() {
									main();
								});
							} else {
								myLog.error("No forts found in path");
								doLoop = false;
								main();
							}
						});
					} else {
						myLog.error("No locations found");
					}
				} else {
					myLog.chat(forts_in_path.length + " Forts in this path");
					main();
				}
			});
		}
	});
}

/**
 * Main process
 */
function main() {
	myLog.info('Current location: ' + pokeAPI.playerInfo.locationName);
	myLog.info('lat/long/alt: : ' + pokeAPI.playerInfo.latitude + ' ' + pokeAPI.playerInfo.longitude + ' ' + pokeAPI.playerInfo.altitude);

	showProfile(function() {
		showInventory({wait: retry_wait, show: doShowInventory, stats: true, trash: doTrash}, function() {
			showPokemon(function() {
				scrapPokemon(function() {
					if(doLoop) {
						runLoop(function() {
							if(break_loop) {
								// start back up if the process exited
								break_loop = false;
								pokeAPI = new PokemonGoAPI();
								fail_count_restart++;
								if(fail_count_restart > 10) {
									myLog.attention("Stopping process due to too many failures");
									return;
								} else {
									myLog.error("Wait " + (retry_wait / 1000) + " seconds between retries; fail_count_restart: " + fail_count_restart);
									setTimeout(function() {
										init();
									}, retry_wait);
									return;
								}
							} else if(take_break) {
								// reset take_break flag
								take_break = false;
								setTimeout(function() {
									init();
								}, getRestartWait());
								return;
							} else if(stop_process) {
								myLog.attention("Stopping process");
								return;
							}
						});
					}
				});
			});
		});
	});
}

/**
 * Get randomized wait to restart time
 *
 * @returns {number}
 */
function getRestartWait() {
	var min = (restart_wait_min * 60) * 1000;
	var max = (restart_wait_max * 60) * 1000;
	var restart_wait = rand(min, max);

	myLog.chat("[*] ######### Process restarting in " + getTimeString(restart_wait) + " #########");

	return restart_wait;
}

/**
 *
 * @param callback
 */
function showProfile(callback) {
	myLog.info("============ PLAYER PROFILE ============");
	poke_storage = player_profile.max_pokemon_storage;
	item_storage = player_profile.max_item_storage;
	myLog.info('\tUsername: ' + player_profile.username);
	myLog.info('\tPoke Storage: ' + poke_storage);
	myLog.info('\tItem Storage: ' + item_storage);

	myLog.info('\tPokecoin: ' + player_profile.currencies[0].amount);
	myLog.info('\tStardust: ' + player_profile.currencies[1].amount);
	callback(true);
}

/**
 * Run the loop to go to provided GPS coordinates
 *
 * @param callback
 */
function runLoop(callback) {
	take_break = isBreakTime();
	if(!break_loop && !stop_process && !take_break) {
		runLocationChecks(call_wait);
		interval = rand(interval_min, interval_max);
		clearInterval(interval_obj);
		myLog.info("Wait interval " + (interval / 1000) + " seconds");
		interval_obj = setInterval(runLoop, interval, callback);
	} else {
		clearInterval(interval_obj);
		callback(true);
	}
}

/**
 * Check if it is time to take a break
 *
 * @returns {boolean}
 */
function isBreakTime() {
	var now = new Date().getTime();
	if(breaktime != null) {
		var diff = breaktime - now;
		if(diff > 0) {
			myLog.chat("Next break in " + getTimeString(diff));
		}
		if(breaktime <= now) {
			breaktime = null;
			return true;
		}
	} else {
		breaktime = getNewBreakTime(now);
		myLog.chat("Next break in " + getTimeString(breaktime - now));
	}
	return false;
}

/**
 * Get time in hours/mins/secs from a timestamp (ms)
 *
 * @param times_in_ms
 * @returns {*}
 */
function getTimeString(times_in_ms) {
	var time_string;
	var secs = Math.floor(times_in_ms / 1000);
	var mins = Math.floor(secs / 60);
	var hours = Math.floor(mins / 60);
	if(hours > 0) {
		var hour_mins = (hours * 60);
		mins = mins - hour_mins;
		if(mins > 0) {
			var min_secs = (mins * 60);
			secs = secs - (min_secs + (hour_mins * 60));
		}
		time_string = hours + " hours " + mins + " minutes " + secs + " seconds";
	} else if(mins > 0) {
		var min_secs = (mins * 60);
		secs = secs - min_secs;
		time_string = mins + " minutes " + secs + " seconds";
	} else {
		time_string = secs + " seconds";
	}

	return time_string;
}

/**
 * Get new time to take a break
 *
 * @param now	Timestamp from which to start
 * @returns {*}
 */
function getNewBreakTime(now) {
	var min = (loop_time_min * 60) * 1000;
	var max = (loop_time_max * 60) * 1000;
	return now + rand(min, max);
}

/**
 * Check locations for things nearby (Pokemon and Poke Stops)
 *
 * @param wait
 */
function runLocationChecks(wait) {
	setTimeout(function() {
		// increment loops when back to starting point
		if(current_location == start_location_num) {
			num_loop++;
			myLog.chat("+++++++ Starting loop " + num_loops + " of " + num_loops + " +++++++");
			if(num_loop > num_loops) {
				stop_process = true;
			}
		}
		current_location++;
		if(current_location >= locations.length) {
			current_location = 0;
		}
		location_num = current_location + 1;
		if(total_distance == null) {
			total_distance = 0;
		} else {
			var previous_location = location;
		}
		location = tweakLocation(locations[current_location]);
		pokeAPI.SetLocation(location, function(err) {
			if(err) {
				myLog.error("From runLocationChecks->pokeAPI.SetLocation:");
				myLog.error(err);
			} else {
				var label = "";
				if(location.label !== undefined) {
					label = location.label;
				}
				myLog.add("Changed location: " + location.coords.latitude + "," + location.coords.longitude + " (" + location_num + " / " + locations.length + ") " + label);

				if(previous_location !== undefined) {
					total_distance += distance(previous_location.coords, location.coords); // in meters
					if(total_distance > 0) {
						myLog.add((total_distance / 1000) + " km traveled so far");
					}
				}
				pokeAPI.Heartbeat(function(err, res) {
					if(err) {
						myLog.error("From runLocationChecks->pokeAPI.Heartbeat:");
						myLog.error(err);
						break_loop = true;
					} else {
						processHeartBeatResponses(res, function() {
							if(res.GET_MAP_OBJECTS !== undefined && res.GET_MAP_OBJECTS.map_cells !== undefined) {
								var cells = res.GET_MAP_OBJECTS.map_cells;
								if(cells.length > 0) {
									var forts = [];
									var pokemon_to_catch = [];
									var nearby_count = 0;
									for(var cell_i in cells) {
										var cell = cells[cell_i];
										if(cell.forts.length > 0) {
											forts.push(cell.forts);
										}

										if(cell.nearby_pokemons.length > 0) {
											for(var near_i in cell.nearby_pokemons) {
												nearby_count++;
												myLog.warning("There is a " + pokeAPI.getPokemonInfo(cell.nearby_pokemons[near_i]).name + " near.");
											}
										}

										// get list of catchable pokemon
										if(cell.catchable_pokemons.length > 0) {
											for(var catch_i in cell.catchable_pokemons) {
												myLog.attention(pokeAPI.getPokemonInfo(cell.catchable_pokemons[catch_i]).name + " is close enough to catch");
												if(pokemon_to_catch.indexOf(cell.catchable_pokemons[catch_i]) < 0) {
													pokemon_to_catch.push(cell.catchable_pokemons[catch_i]);
												}
											}
										}
									}

									if(nearby_count == 0) {
										nothing_nearby_count++;
										myLog.warning("There is nothing nearby");
										if(nothing_nearby_count >= nothing_nearby_max) {
											stop_process = true;
											myLog.error("There has been nothing nearby " + nothing_nearby_count + " times; something might be wrong (probably captcha)");
										}
									} else {
										nothing_nearby_count = 0;
									}

									checkForts(forts, function(options) {
										if(options.lured_pokemon !== undefined && options.lured_pokemon.length > 0) {
											pokemon_to_catch = pokemon_to_catch.concat(options.lured_pokemon);
										}
										var total = options.items.length;
										showItemsAcquired(options.items, "Acquired", function() {
											var show = false;
											if(total != null && total > 0) {
												show = true;
											}

											var stats = false;
											if(options.xp_earned != null && options.xp_earned > 0) {
												stats = true;
											}
											showInventory({
												wait: call_wait,
												show: show,
												stats: stats,
												trash: doTrash
											}, function() {
												// maybe do something
											});
										});

										myLog.info(pokemon_to_catch.length + " catchable pokemon nearby");
										catchPokemonList({pokemon_list: pokemon_to_catch}, function() {
											addPokemonToFavorites(function() {
												// maybe do something
											});
										});
									});
								} else {
									myLog.error("No cells returned - something is wrong");
									stop_process = true;
								}
							} else {
								myLog.warning("No map cells found in this location");
							}
						});
					}
				});
			}
		});
	}, wait);
}

/**
 *
 * @param res
 * @param callback
 */
function processHeartBeatResponses(res, callback) {
	for(var i in res) {
		var result = res[i];
		switch(i) {
			case "GET_MAP_OBJECTS":
				// implemented outside of this method
				break;
			case "GET_PLAYER":
				if(result.success) {
					player_profile = result.player_data;
					if(player_profile.daily_bonus !== undefined && player_profile.daily_bonus !== null) {
						var now = new Date().getTime();
						var diff = player_profile.daily_bonus.next_defender_bonus_collect_timestamp_ms - now;
						if(diff > 0) {
							myLog.info("[i] " + getTimeString(diff) + " til next collect");
						} else {
							deploy_collect = true;
						}
					}
				}
				break;
			case "GET_HATCHED_EGGS":
				if(result.success) {
					if(result.pokemon_id.length > 0) {
						showPreviouslyHatchedEggs(function() {
							for(var j in result.pokemon_id) {
								getPokemonByPokemonId(result.pokemon_id[j], function(pokemon) {
									if(pokemon !== null) {
										myLog.success("\t" + pokeAPI.getPokemonInfo(pokemon).name + " hatched");
									} else {
										myLog.success("\tUnknown pokemon hatched (" + result.pokemon_id[j] + ")");
										hatched_pokemon.push(result.pokemon_id[j]);
									}
								});
							}
							award_num = sumArray(result.experience_awarded);
							if(award_num > 0) {
								myLog.success("\t" + award_num + " XP awarded");
							}
							award_num = sumArray(result.candy_awarded);
							if(award_num > 0) {
								myLog.success("\t" + award_num + " Candy awarded");
							}
							award_num = sumArray(result.stardust_awarded);
							if(award_num > 0) {
								myLog.success("\t" + award_num + " Stardust awarded");
							}
						});
					}
				}
				break;
			case "GET_BUDDY_WALKED":
				if(result.success) {
					if(result.candy_earned_count > 0) {
						myLog.success("\t" + result.candy_earned_count + " " + pokeAPI.getPokemonFamilyName(result.family_candy_id) + " Candy earned from walking");
					}
				}
				break;
			case "GET_INVENTORY":
				if(result.success) {
					if(result.inventory_delta.inventory_items) {
						processGetInventoryResponse(result.inventory_delta.inventory_items, function() {
							if(eggs.length > 0 && incubators.length > 0) {
								eggs.sort(pokeAPI.dynamicSort("egg_km_walked_target"));
								incubateEggs(function() {
									// done
								});
							}
						});
					}
				}
				break;
			case "CHECK_AWARDED_BADGES":
				if(result.success) {
					if(result.awarded_badges.length > 0) {
						for(var j in result.awarded_badges) {
							myLog.success("\tBadge earned: " + pokeAPI.getBadgeType(result.awarded_badges[j]) + " (level " + result.awarded_badge_levels[j] + ")");
						}
					}
				}
				break;
			case "COLLECT_DAILY_DEFENDER_BONUS":
				if(result.result == 1 && deploy_collect) {
					myLog.success("Collection successful");
					if(result.currency_awarded.length > 0) {
						for(var j in result.currency_awarded) {
							myLog.success("\t" + result.currency_awarded[j] + " " + pokeAPI.formatString(result.currency_type[j]) + " awarded");
							deploy_collect = false;
						}
					}
				} else {
					myLog.info("Unable to collect: " + pokeAPI.getCollectDailyDefenderBonusResult(result.result));
				}
				break;
			case "DOWNLOAD_SETTINGS":
				// not sure what to do with this... maybe nothing
				break;
			default:
				myLog.warning(i + " result not yet implemented: " + JSON.stringify(res[i]));
		}
	}

	callback(true);
}

function showPreviouslyHatchedEggs(callback) {
	if(hatched_pokemon.length > 0) {
		var pokemon_id = hatched_pokemon.pop();
		myLog.chat("########### CHECKING PREVIOUSLY HATCHED EGG ############");
		myLog.chat(pokemon_id.toString());
		getPokemonByPokemonId(pokemon_id, function(pokemon) {
			if(pokemon !== null) {
				myLog.success("\tPreviously hatched pokemon " + pokeAPI.getPokemonInfo(pokemon).name + " (" + pokemon_id + ")");
			} else {
				myLog.success("\tPreviously hatched pokemon still unknown (" + pokemon_id + ")");
			}
			showPreviouslyHatchedEggs(callback);
		});
	} else {
		callback(true);
	}
}

function getPokemonByPokemonId(pokemon_id, callback) {
	for(var i in pokemon_list) {
		var pokemon = pokemon_list[i];
		if(pokemon.id.toString() == pokemon_id.toString()) {
			callback(pokemon);
		}

		if(i >= (pokemon_list.length - 1)) {
			callback(null);
		}
	}
}

/**
 *
 * @param callback
 */
function incubateEggs(callback) {
	// sort eggs
	if(eggs.length > 0 && incubators.length > 0) {
		var incubator = incubators.pop();
		if(parseInt(incubator.pokemon_id) === 0) {
			var egg = eggs.pop();
			setTimeout(function() {
				pokeAPI.UseItemEggIncubator(incubator.id, egg.id, function(err, res) {
					if(err) {
						myLog.error(err);
					} else {
						if(res.result == 1) {
							myLog.success("Incubating " + egg.egg_km_walked_target + "km egg");
						} else {
							myLog.warning("Using egg incubator failed: " + pokeAPI.getUseItemEggIncubatorResult(res.result));
						}
					}
					incubateEggs(callback);
				});
			}, call_wait);
		} else {
			incubateEggs(callback);
		}
	} else {
		callback(true);
	}
}

/**
 *
 * @param items
 * @param callback
 */
function processGetInventoryResponse(items, callback) {
	if(doWriteInventory) {
		fs.writeFile(inventory_file, JSON.stringify(items), function(err) {
			if(err) {
				myLog.error(err);
			}
		});
	}
	// reset arrays
	pokeball_counts = [0];
	inventory_items = [];
	pokemon_list = [];
	pokemon_grouped = [];
	incubators = [];
	eggs = [];
	for(var j in items) {
		if(items[j].inventory_item_data !== undefined && items[j].inventory_item_data !== null) {
			// items
			var entry = items[j].inventory_item_data;
			if(entry.item !== undefined && entry.item !== null) {
				var item = entry.item;
				var item_name = pokeAPI.getItemInfo(item).name;
				var item_count = item.count;
				if(item_name.indexOf("Ball") > -1) {
					pokeball_counts[0] += item_count;
					pokeball_counts[item.item_id] = item_count;
				}

				inventory_items.push(item);

				if(doTrash) {
					if(trash_items != null && trash_items.indexOf(item_name) > -1 && item_count > 0) {
						items_to_trash.push({item_id: item.item_id, count: item_count});
					}
				}
			}
			// incubators
			if(entry.egg_incubators !== undefined && entry.egg_incubators !== null) {
				if(entry.egg_incubators.egg_incubator !== undefined && entry.egg_incubators.egg_incubator !== null) {
					if(entry.egg_incubators.egg_incubator.length > 0) {
						for(var i in entry.egg_incubators.egg_incubator) {
							var incubator = entry.egg_incubators.egg_incubator[i];
							incubators.push(incubator);
						}
					}
				}
			}
			// pokemon && eggs
			if(entry.pokemon_data != null) {
				var pokemon = entry.pokemon_data;
				if(!pokemon.is_egg) {
					var pokemon_id = parseInt(pokemon.pokemon_id);
					pokemon.info = pokeAPI.getPokemonInfo(pokemon);

					if(pokemon_grouped[pokemon_id] === undefined) {
						pokemon_grouped[pokemon_id] = [];
					}
					pokemon_grouped[pokemon_id].push(pokemon);
					pokemon_list.push(pokemon);

					var score = pokemon.individual_attack + pokemon.individual_defense + pokemon.individual_stamina;
					if(best_pokemon[pokemon_id] === undefined) {
						best_pokemon[pokemon_id] = pokemon;
					} else {
						var current_best = best_pokemon[pokemon_id];
						var current_best_score = current_best.individual_attack + current_best.individual_defense + current_best.individual_stamina;
						if(score > current_best_score) {
							best_pokemon[pokemon_id] = pokemon;
						} else if(score == current_best_score) {
							if(pokemon.cp > current_best.cp) {
								best_pokemon[pokemon_id] = pokemon;
							} else if(pokemon.cp == current_best.cp) {
								if(pokemon.stamina_max > current_best.stamina_max) {
									best_pokemon[pokemon_id] = pokemon;
								}
							}
						}
					}
				} else {
					if(!pokemon.egg_incubator_id) {
						eggs.push(pokemon);
					}
				}
			}
			// player stats
			if(entry.player_stats !== undefined && entry.player_stats !== null) {
				if(player_stats !== null) {
					if(player_stats.level != entry.player_stats.level) {
						myLog.success("LEVELED UP: " + entry.player_stats.level);
						pokeAPI.GetLevelUpRewards(entry.player_stats.level, function(err, res) {
							if(err) {
								myLog.error(err);
							} else {
								if(res) {
									if(res.result == 1) {
										if(res.items_awarded.length > 0) {
											showItemsAcquired(res.items_awarded, "Awarded", function() {
												// done
											});
										}
										if(res.items_unlocked.length > 0) {
											showItemsAcquired(res.items_unlocked, "Unlocked", function() {
												// done
											});
										}
									} else {
										myLog.warning("There was a problem getting level up rewards: " + pokeAPI.getLevelUpRewardsResult(res.result));
									}
								}
							}
						});
					}
				}
				player_stats = entry.player_stats;
			}
		}
		if(j >= (items.length - 1)) {
			callback(true);
		}
	}
}

/**
 * Show the items acquired at a Poke Stop
 *
 * @param items
 * @param label
 * @param callback
 */
function showItemsAcquired(items, label, callback) {
	if(items.length > 0) {
		var item = items.pop();
		var info = pokeAPI.getItemInfo(item);
		var name = info.name;
		var count = item.item_count;

		myLog.success("\t" + label + " " + count + "x " + name);
		showItemsAcquired(items, label, callback);
	} else {
		callback(true);
	}
}

/**
 * Catch Pokemon provided
 *
 * @param options
 * @param callback
 */
function catchPokemonList(options, callback) {
	if(doCatch) {
		if(options.pokemon_list.length > 0) {
			var pokemon = options.pokemon_list.pop();
			var lured = false;
			if(pokemon.fort_id !== undefined && pokemon.fort_id != null) {
				lured = true;
			}
			if(pokeball_counts[0] > 0) {
				var pokemon_info = pokeAPI.getPokemonInfo(pokemon);
				var pokemon_name = pokemon_info.name;
				if(lured) {
					pokemon_name = pokemon_name + " **lured**";
				}
				pokeAPI.EncounterPokemon(pokemon, function(encounter_err, encounter_res) {
					if(encounter_err) {
						myLog.warning("Unable to encounter pokemon " + pokemon_name + " (" + encounter_err + ")");
						setTimeout(function() {
							catchPokemonList(options, callback);
						}, call_wait);
					} else {
						if(encounter_res.status !== undefined || encounter_res.result !== undefined) {
							var encounter_status_id;
							var encounter_status_value;
							var pokemon_data = null;
							if(encounter_res.status !== undefined) {
								encounter_status_id = encounter_res.status;
								encounter_status_value = pokeAPI.getEncounterStatus(encounter_status_id);
								if(encounter_res.wild_pokemon && encounter_res.wild_pokemon.pokemon_data) {
									pokemon_data = encounter_res.wild_pokemon.pokemon_data;
								}
							} else {
								encounter_status_id = encounter_res.result;
								encounter_status_value = pokeAPI.getDiskEncounterResult(encounter_status_id);
								if(encounter_res.pokemon_data) {
									pokemon_data = encounter_res.pokemon_data;
								}
							}
							if(encounter_status_id == 1 && pokemon_data != null) {
								var pokemonScore = pokemon_data.individual_attack + pokemon_data.individual_defense + pokemon_data.individual_stamina;
								var pokemon_stats_string = pokemon_data.cp + " :: " + pokemonScore + " / " + perfect_score;
								myLog.chat("Encountered pokemon " + pokemon_name + " :: " + pokemon_stats_string + "...");
								catchPokemon(pokemon, pokemon_data, encounter_res, function() {
									setTimeout(function() {
										catchPokemonList(options, callback);
									}, call_wait);
								});
							} else {
								myLog.warning("There was a problem when trying to encounter pokemon " + pokemon_name + " (" + encounter_status_value + ")");
								// if pokemon inventory is full
								if(encounter_status_id == 7) {
									scrapPokemon(function(scrapped) {
										if(scrapped) {
											options.pokemon_list.push(pokemon);
											setTimeout(function() {
												catchPokemonList(options, callback);
											}, call_wait);
										} else {
											myLog.info("Cannot catch - unable to scrap");
											callback(options);
										}
									});
								} else {
									myLog.warning(JSON.stringify(encounter_res));
									setTimeout(function() {
										catchPokemonList(options, callback);
									}, call_wait);
								}
							}
						} else {
							myLog.warning("EncounterStatus is undefined when trying to encounter pokemon " + pokemon_name);
							myLog.warning(JSON.stringify(encounter_res));
							setTimeout(function() {
								catchPokemonList(options, callback);
							}, call_wait);
						}
					}
				});
			} else {
				myLog.warning("Out of Poke Balls :(");
				callback(options);
			}
		} else {
			callback(options);
		}
	} else {
		myLog.info("Not catching - doCatch flag is set to false");
		callback(options);
	}
}

function catchPokemon(pokemon, pokemon_data, encounter_res, callback) {
	var pokemon_info = pokeAPI.getPokemonInfo(pokemon);
	var pokemon_name = pokemon_info.name;
	var pokemonScore = pokemon_data.individual_attack + pokemon_data.individual_defense + pokemon_data.individual_stamina;
	var pokemon_stats_string = pokemon_data.cp + " :: " + pokemonScore + " / " + perfect_score;
	getBallToUse(encounter_res, function(pokeball_id) {
		if(pokeball_id != null) {
			var hitPokemon = getHitPokemon(5);
			var hitPosition = getHitPosition();
			var reticleSize = getReticleSize();
			var spinModifier = getSpinModifier();
			myLog.chat("#### Catch Params #### HIT: " + hitPokemon.toString() + " POS: " + hitPosition + " RET: " + reticleSize + " SPIN: " + spinModifier + " BALL: " + pokeball_id);
			pokeAPI.CatchPokemon(pokemon, hitPokemon, hitPosition, reticleSize, spinModifier, pokeball_id, function(catch_err, catch_res) {
				if(catch_err && catch_err != "No result") {
					myLog.warning("Unable to catch " + pokemon_name + "; ERROR: " + catch_err);
					callback(true);
				} else {
					// decrement total and ball used
					pokeball_counts[0]--;
					pokeball_counts[pokeball_id]--;
					if(catch_res !== undefined && catch_res.status !== undefined) {
						var status = catch_res.status;
						var status_str = pokeAPI.getCatchStatus(status);
						if(status == 1) {
							myLog.success(status_str + " " + pokemon_name + " :: " + pokemon_stats_string);
							if(pokemonScore == perfect_score) {
								queuePokemonToFavorite({
									id: catch_res.captured_pokemon_id,
									pokemon_id: pokemon_data.pokemon_id
								});
							}
							callback(true);
						} else {
							myLog.warning(status_str + " " + pokemon_name);
							if(status == 0 || status == 2 || status == 4) {
								myLog.warning("trying again...");
								setTimeout(function() {
									catchPokemon(pokemon, pokemon_data, encounter_res, callback);
								}, call_wait);
							} else {
								callback(true);
							}
						}
						if(catch_res.capture_award !== undefined && catch_res.capture_award != null) {
							award_num = sumArray(catch_res.capture_award.xp);
							if(award_num > 0) {
								myLog.success("\t" + award_num + " XP awarded");
							}
							award_num = sumArray(catch_res.capture_award.candy);
							if(award_num > 0) {
								myLog.success("\t" + award_num + " Candy awarded");
							}
							award_num = sumArray(catch_res.capture_award.stardust);
							if(award_num > 0) {
								myLog.success("\t" + award_num + " Stardust awarded");
							}
						}
					} else {
						myLog.warning("Unable to catch " + pokemon_name + "; status not defined (" + catch_res + ")");
						callback(true);
					}
				}
			});
		} else {
			myLog.warning("Unable to get ball to use: " + JSON.stringify(pokeball_counts));
			callback(true);
		}
	});
}

/**
 * Randomize hitting pokemon - miss 1 in max times
 *
 * @returns {boolean}
 */
function getHitPokemon(max) {
	var num = rand(1, max);
	if(num == 1) {
		return false;
	} else {
		return true;
	}
}

/**
 * Get hit position (1 in reticle, 0 not in reticle)
 *
 * @returns {number}
 */
function getHitPosition() {
	//return 1;
	return rand(0, 1);
}

/**
 * Get randomized reticle size
 *
 * @returns {number}
 */
function getReticleSize() {
	//return 1.950; // excellent
	//var min = 1850;
	//var max = 1950;

	var min = 1050;
	var max = 1950;
	return rand(min, max) / 1000;
}

/**
 * Get a randomized spin modifier
 *
 * @returns {number}
 */
function getSpinModifier() {
	//var spinModifier = 1;
	//var min = 85;
	//var max = 100;
	//return rand(min, max) / 100;
	return rand(0, 1);
}

/**
 * Get the Poke ball to use
 *
 * @param encounter_result
 * @param callback
 */
function getBallToUse(encounter_result, callback) {
	var prob_perc = [];
	if(encounter_result.capture_probability !== undefined && encounter_result.capture_probability !== null) {
		var prob = encounter_result.capture_probability;
		for(var i in prob.pokeball_type) {
			prob_perc[prob.pokeball_type[i]] = prob.capture_probability[i] * 100;
		}
	}
	var ball_to_use = null;
	for(var ballIndex in pokeball_counts) {
		if(ballIndex != 0) {
			var ballInt = parseInt(ballIndex);
			var ball_prob = 0;
			if(prob_perc[ballIndex] !== undefined) {
				ball_prob = prob_perc[ballIndex];
			}
			myLog.info("\t" + pokeball_counts[ballIndex] + " " + pokeAPI.getItemInfo({item_id: ballInt}).name + "s (catch probability: " + ball_prob.toFixed(2) + "%)");
			if(pokeball_counts[ballIndex] != null && pokeball_counts[ballIndex] > 0) {
				if(ball_to_use === null) {
					ball_to_use = ballInt;
				} else if(prob_perc[ball_to_use] < min_catch_probability) {
					ball_to_use = ballInt;
				}
			}

			if(ballInt >= (pokeball_counts.length - 1)) {
				callback(ball_to_use);
			}
		} else {
			myLog.info(pokeball_counts[ballIndex] + " total poke balls");
		}
	}
}

/**
 * Show inventory
 *
 * @param options
 * @param callback
 */
function showInventory(options, callback) {
	// wait between tries
	if(options.show || options.trash || options.stats) {
		var total = -1; // to account for the unlimited incubator
		if(options.show) {
			myLog.info("============ INVENTORY ============");
			for(var i in inventory_items) {
				var item = inventory_items[i];
				var item_name = pokeAPI.getItemInfo(item).name;
				var item_count = item.count;
				total += item_count;
				myLog.info("\t" + item_count + "x " + item_name + "s");
			}
			myLog.info("######### " + total + " / " + item_storage + " items #########");
		}

		showPlayerStats(options.stats, function() {
			if(options.trash) {
				trashItems(items_to_trash, function() {
					callback(true);
				});
			} else {
				callback(true);
			}
		});
	} else {
		callback(true);
	}
}

/**
 *
 * @param show
 * @param callback
 */
function showPlayerStats(show, callback) {
	if(show) {
		myLog.info("============ PLAYER STATS ============");
		myLog.info("\tLevel: " + player_stats.level);
		myLog.info("\tExperience: " + player_stats.experience);
		myLog.info("\tNext Level: " + player_stats.next_level_xp);
		myLog.info("\tNext Level Remaining: " + (parseInt(player_stats.next_level_xp) - parseInt(player_stats.experience)));
		myLog.info("\tPokemon Encountered: " + player_stats.pokemons_encountered);
		myLog.info("\tPokemon Captured: " + player_stats.pokemons_captured);
		myLog.info("\tEvolutions: " + player_stats.evolutions);
		myLog.info("\tPoke Stop Visits: " + player_stats.poke_stop_visits);
		myLog.info("\tPokeballs Thrown: " + player_stats.pokeballs_thrown);
		myLog.info("\tEggs Hatched: " + player_stats.eggs_hatched);
	}
	callback(true);
}

/**
 *
 * @param items
 * @param callback
 */
function trashItems(items, callback) {
	if(items.length > 0) {
		var item = items.pop();
		pokeAPI.DropItem(item.item_id, item.count, function(err, dat) {
			var itemName = pokeAPI.getItemInfo(item).name;
			if(err) {
				myLog.error(err);
			} else {
				if(dat !== undefined && dat.result !== undefined && dat.result != null) {
					if(dat.result == 1) {
						myLog.success("Successfully trashed " + item.count + " " + itemName + "s");
						var count = 0;
						if(dat.new_count != null) {
							count = dat.new_count;
						}
						myLog.info(count + " " + itemName + "s left");
					} else {
						myLog.warning("There was a problem trashing " + itemName + "s: " + pokeAPI.getRecycleItemResult(dat.result));
					}

				} else {
					myLog.warning(JSON.stringify(item));
					myLog.warning(JSON.stringify(dat));
				}
			}
			setTimeout(function() {
				trashItems(items, callback);
			}, call_wait);
		});
	} else {
		callback(true);
	}
}

/**
 * Show Pokemon owned by user
 *
 * @param callback
 */
function showPokemon(callback) {
	if(doShowPokemon) {
		var total = 0;
		if(pokemon_list !== undefined && pokemon_list.length > 0) {
			myLog.info("============ POKEMON ============");
			for(var i in pokemon_list) {
				total++;
				var pokemon = pokemon_list[i];
				var score = pokemon.individual_attack + pokemon.individual_defense + pokemon.individual_stamina;
				var info_str = formatStringLen(pokemon.info.name, (pokeAPI.getMaxPokemonNameLength() + 5)) + formatStringLen("CP: " + pokemon.cp) + formatStringLen("HP: " + pokemon.stamina + "/" + pokemon.stamina_max, 15) + formatStringLen("AT: " + pokemon.individual_attack) + formatStringLen("DE: " + pokemon.individual_defense) + formatStringLen("ST: " + pokemon.individual_stamina) + "SCORE: " + formatStringLen(score, 3) + "/" + formatStringLen(perfect_score, 5);
				if(score == perfect_score) {
					if(pokemon.favorite) {
						myLog.success("############### PERFECT & FAVORITE ###################");
					} else {
						myLog.success("############### PERFECT ###################");
						// add to favorites if not already
						queuePokemonToFavorite(pokemon);
					}
					myLog.success(info_str);
				} else if(pokemon.favorite) {
					myLog.chat("############### FAVORITE ###################");
					myLog.chat(info_str);
				} else {
					myLog.info(info_str);
				}

				if(i >= (pokemon_list.length - 1)) {
					myLog.info("######### " + total + " / " + poke_storage + " pokemon #########");
					addPokemonToFavorites(function() {
						callback(true);
					});
				}
			}
		} else {
			callback(true);
		}
	} else {
		callback(true);
	}
}

/**
 *
 * @param pokemon
 */
function queuePokemonToFavorite(pokemon) {
	if(pokemon.info === undefined || pokemon.info == null) {
		pokemon.info = pokeAPI.getPokemonInfo(pokemon);
	}
	add_to_favorites.push(pokemon);
}

/**
 *
 * @param callback
 */
function addPokemonToFavorites(callback) {
	if(add_to_favorites !== undefined && add_to_favorites != null && add_to_favorites.length > 0) {
		var pokemon = add_to_favorites.pop();
		pokeAPI.SetFavoritePokemon(pokemon.id, true, function(err, data) {
			if(err) {
				myLog.error("From addPokemonToFavorites->pokeAPI.SetFavoritePokemon:");
				myLog.error(err);
				myLog.error("Wait " + (retry_wait / 1000) + " seconds between retries");
				addPokemonToFavorites(callback);
			} else {
				if(data !== undefined && data.result !== undefined) {
					if(data.result == 1) {
						myLog.success("Successfully added " + pokemon.info.name + " to favorites");
					} else {
						var result = data.result;
						if(statuses.favorite[data.result] !== undefined) {
							result = statuses.favorite[data.result];
						}
						myLog.warning("Unable to add " + pokemon.info.name + " to favorites: " + result);
					}
				}
				addPokemonToFavorites(callback);
			}
		});
	} else {
		callback(true);
	}
}

/**
 * Send extra Pokemon to the meat grinder
 *
 * @param callback
 */
function scrapPokemon(callback) {
	if(doScrap) {
		if(allow_scrap) {
			pokemon_to_scrap = [];
			getPokemonToScrap(function() {
				myLog.chat("Will try to scrap " + pokemon_to_scrap.length + " / " + pokemon_list.length + " pokemon");
				transferPokemon(function() {
					callback(true);
				});
			});
		} else {
			myLog.warning("\tNOT SCRAPPING: allow_scrap flag not set or false in user config");
			callback(false);
		}
	} else {
		callback(false);
	}
}

/**
 * Get Pokemon to scrap: not perfect, favorite, or best of each type. Perfect and best could be the same.
 *
 * @param callback
 */
function getPokemonToScrap(callback) {
	if(pokemon_grouped.length > 0) {
		var pokemon_group = pokemon_grouped.pop();
		if(pokemon_group !== undefined && pokemon_group.length > 0) {
			for(var i in pokemon_group) {
				var pokemon = pokemon_group[i];
				var pokemon_id = parseInt(pokemon.pokemon_id);
				var score = pokemon.individual_attack + pokemon.individual_defense + pokemon.individual_stamina;

				if(score == perfect_score) {
					myLog.success("WON'T SCRAP - PERFECT " + pokeAPI.getPokemonInfo(pokemon).name);
				} else if(pokemon.favorite) {
					myLog.chat("WON'T SCRAP - FAVORITE " + pokeAPI.getPokemonInfo(pokemon).name);
				} else if(best_pokemon[pokemon_id] !== undefined && best_pokemon[pokemon_id].id.toString() == pokemon.id.toString()) {
					myLog.info("WON'T SCRAP - BEST FOR " + pokeAPI.getPokemonInfo(pokemon).name);
				} else {
					pokemon_to_scrap.push(pokemon);
				}


				if(i >= (pokemon_group.length - 1)) {
					getPokemonToScrap(callback);
				}
			}
		} else {
			getPokemonToScrap(callback);
		}
	} else {
		callback(true);
	}
}

/**
 * Format string for a more pleasing view
 *
 * @param str
 * @param len
 * @returns {*}
 */
function formatStringLen(str, len) {
	if(len === undefined || len == null) {
		len = 10;
	}
	while(str.length < len) {
		str = str + " ";
	}
	return str;
}

/**
 * Send Pokemon to the meat grinder
 *
 * @param callback
 */
function transferPokemon(callback) {
	if(pokemon_to_scrap.length > 0) {
		var pokemon = pokemon_to_scrap.pop();
		myLog.info("SCRAPPING POKEMON: " + pokemon.info.name + " (" + pokemon_to_scrap.length + " remaining)");
		pokeAPI.TransferPokemon(pokemon.id, function(err, dat) {
			if(err) {
				myLog.error(err);
				myLog.warning(JSON.stringify(dat));
			} else {
				myLog.success("\tSCRAPPED POKEMON: " + pokemon.info.name);
			}

			// any more items in array? continue loop
			if(pokemon_list.length > 0) {
				setTimeout(function() {
					transferPokemon(callback);
				}, call_wait);
			} else {
				callback(true);
			}
		});
	} else {
		callback(true);
	}
}

/**
 * Check forts nearby
 *
 * @param fortCells
 * @param callback
 */
function checkForts(fortCells, callback) {
	var options = {};

	options.cellsNearby = fortCells;
	getFortsNearby(options, function() {
		getPokeStops(options, function() {
			getGyms(options, function() {
				callback(options);
			});
		});
	});
}

/**
 * Deploy to gym and collect
 *
 * @param options
 * @param callback
 */
function getGyms(options, callback) {
	if(doDeploy) {
		if(options.gyms !== undefined && options.gyms.length > 0 && deploy_collect) {
			var gym = options.gyms.pop();
			if(gym.owned_by_team == 0 || gym.owned_by_team == player_profile.team) {
				pokeAPI.getGymDetails(gym, function(gym_details_err, gym_details) {
					if(gym_details_err) {
						myLog.error(gym_details_err);
						setTimeout(function() {
							getGyms(options, callback);
						}, call_wait);
					} else {
						if(gym_details.memberships !== undefined && gym_details.memberships !== null) {
							pokeAPI.getGymeLevel(gym, function(gym_level_err, gym_level) {
								if(gym_level_err) {
									myLog.error(gym_level_err);
									setTimeout(function() {
										getGyms(options, callback);
									}, call_wait);
								} else {
									if(gym_details.memberships < gym_level) {
										getPokemonToDeploy(function(pokemon) {
											myLog.chat("=== DEPLOYING TO GYM ===");
											pokeAPI.FortDeployPokemon(gym, pokemon.id, function(err, res) {
												if(err) {
													myLog.error(err);
												} else {
													if(res !== undefined && res.result !== undefined) {
														if(res.result == 1) {
															myLog.success("Deployed " + pokemon.info.name + " pokemon to gym");
															pokeAPI.CollectDailyDefenderBonus(function(err, res) {
																if(err) {
																	myLog.error(err);
																} else {
																	if(res !== undefined && res.result !== undefined) {
																		if(res.result == 1) {
																			myLog.success("Collection successful");
																			if(res.currency_awarded.length > 0) {
																				for(var j in res.currency_awarded) {
																					myLog.success("\t" + res.currency_awarded[j] + " " + pokeAPI.formatString(res.currency_type[j]) + " awarded");
																					deploy_collect = false;
																				}
																			}
																		} else {
																			myLog.info("Unable to collect: " + pokeAPI.getCollectDailyDefenderBonusResult(res.result));
																		}
																	} else {
																		myLog.warning(JSON.stringify(res));
																	}
																}
															});
														} else {
															myLog.warning("Unable to deploy to gym: " + pokeAPI.getFortDeployPokemonResult(res.result));
														}
													} else {
														myLog.warning(JSON.stringify(res));
													}
												}
												setTimeout(function() {
													getGyms(options, callback);
												}, call_wait);
											});
										});
									} else {
										myLog.warning("=== NOT DEPLOYING TO GYM - NO ROOM ===");
										setTimeout(function() {
											getGyms(options, callback);
										}, call_wait);
									}
								}
							});
						} else {
							myLog.warning("gym_details.memberships is undefined or null");
							setTimeout(function() {
								getGyms(options, callback);
							}, call_wait);
						}
					}
				});
			}
		} else {
			callback(true);
		}
	} else {
		callback(true);
	}
}

/**
 *
 * @param callback
 */
function getPokemonToDeploy(callback) {
	for(var i in pokemon_list) {
		var pokemon = pokemon_list[i];
		if(pokemon.stamina == pokemon.stamina_max) {
			return callback(pokemon);
		}

		if(i >= (pokemon_list.length - 1)) {
			callback(null);
		}
	}
}

/**
 * Hit Poke stops nearby
 *
 * @param options
 * @param callback
 */
function getPokeStops(options, callback) {
	if(options.items === undefined) {
		options.items = [];
	}
	if(options.xp_earned === undefined || options.xp_earned === null) {
		options.xp_earned = 0;
	}
	if(options.pokeStops.length > 0) {
		var fort = options.pokeStops.pop();
		var lure = false;
		if(fort.lure_info !== undefined && fort.lure_info != null) {
			lure = true;
			if(fort.lure_info.active_pokemon_id !== undefined && fort.lure_info.active_pokemon_id != null) {
				if(options.lured_pokemon === undefined) {
					options.lured_pokemon = [];
				}
				var pokemon = {
					pokemon_id: fort.lure_info.active_pokemon_id,
					encounter_id: fort.lure_info.encounter_id,
					fort_id: fort.lure_info.fort_id
				};
				myLog.attention(pokeAPI.getPokemonInfo(pokemon).name + " has been lured");
				options.lured_pokemon.push(pokemon);
			}
		}
		var now = new Date().getTime();
		if(fort.cooldown_complete_timestamp_ms <= now) {
			myLog.chat("=== APPROACHING POKESTOP" + (lure ? " WITH LURE" : "") + " ===");
			pokeAPI.GetFort(fort, function(err, data) {
				if(err) {
					myLog.error("From getPokeStops->pokeAPI.GetFort:");
					myLog.error(err);
					fail_count++;
					if(fail_count > 10) {
						process.exit();
					}
					options.pokeStops.push(fort);
					myLog.error("Wait " + (retry_wait / 1000) + " seconds between retries; fail_count: " + fail_count);
					setTimeout(function() {
						getPokeStops(options, callback);
					}, retry_wait);
				} else {
					fail_count = 0;
					if(data != undefined) {
						if(data.experience_awarded !== undefined && data.experience_awarded !== null && data.experience_awarded > 0) {
							options.xp_earned += data.experience_awarded;
							myLog.success(data.experience_awarded + " XP earned");
						}
						if(data.items_awarded !== undefined && data.items_awarded.length > 0) {
							for(var itemIndex = 0; itemIndex < data.items_awarded.length; itemIndex++) {
								var item = data.items_awarded[itemIndex];
								options.items.push(item);
							}
						} else if(data.result != 1) {
							myLog.warning(pokeAPI.getFortSearchResult(data.result));
						}
					}
					setTimeout(function() {
						getPokeStops(options, callback);
					}, call_wait);
				}
			});
		} else {
			myLog.chat("=== NOT APPROACHING POKESTOP" + (lure ? " WITH LURE" : "") + " - COOLING DOWN ===");
			setTimeout(function() {
				getPokeStops(options, callback);
			}, call_wait);
		}
	} else {
		callback(options.xp_earned);
	}
}

/**
 * Get Poke stops nearby
 *
 * @param options        should contain cellsNearby and pokeStops arrays
 * @param callback
 */
function getFortsNearby(options, callback) {
	if(options.pokeStops === undefined) {
		options.pokeStops = [];
	}
	if(options.cellsNearby.length > 0) {
		options.forts = options.cellsNearby.pop();
		areFortsNearby(options, function() {
			getFortsNearby(options, callback);
		});
	} else {
		callback(true);
	}
}

/**
 * Checks if Poke stops are close enough to hit
 *
 * @param options
 * @param callback
 */
function areFortsNearby(options, callback) {
	if(options.pokeStops === undefined) {
		options.pokeStops = [];
	}
	if(options.gyms === undefined) {
		options.gyms = [];
	}
	if(options.forts.length > 0) {
		var fort = options.forts.pop();

		var fortLocation = {'latitude': fort.latitude, 'longitude': fort.longitude};
		var myPosition = {'latitude': location.coords.latitude, 'longitude': location.coords.longitude};
		var distanceToFort = distance(myPosition, fortLocation);

		// within 40 meters
		if(distanceToFort < max_dist) {
			//myLog.attention(fortLocation.latitude + "," + fortLocation.longitude + " (" + fort.type + ") is CLOSE ENOUGH (" + distanceToFort + ")");
			//fort.type 1 is a pokestop - 0 is a gym
			if(fort.type == 1) {
				options.pokeStops.push(fort);
			} else {
				options.gyms.push(fort);
			}
		} else {
			//myLog.attention(fortLocation.latitude + "," + fortLocation.longitude + " (" + fort.type + ") is too far away (" + distanceToFort + ")");
		}
		areFortsNearby(options, callback);
	} else {
		callback(true);
	}
}

/**
 *
 * @param options
 * @param callback
 */
function getPath(options, callback) {
	if(options.locations.length > 0) {
		var location = options.locations.shift();
		var point = new LatLon(location.latitude, location.longitude);
		if(options.last_location === undefined || options.last_location == null) {
			options.first_location = location;
			options.last_location = location;
			addToLocations(point, "Poke Stop");
			getPath(options, callback);
		} else {
			var last_coords = {latitude: options.last_location.latitude, longitude: options.last_location.longitude};
			var current_coords = {latitude: location.latitude, longitude: location.longitude};
			var dist = distance(last_coords, current_coords);
			if(dist > max_walk_dist) {
				//myLog.info("Too far between points - need to add points between (" + dist + ")");
				getIntermediatePoints({
					point1: last_coords,
					point2: current_coords,
					percent: (max_walk_dist / dist)
				}, function() {
					addToLocations(point, "Poke Stop");
				});
			}
			options.last_location = location;
			getPath(options, callback);
		}
	} else {
		var last_coords = {latitude: options.last_location.latitude, longitude: options.last_location.longitude};
		var first_coords = {latitude: options.first_location.latitude, longitude: options.first_location.longitude};
		var dist = distance(last_coords, first_coords);
		if(dist > max_walk_dist) {
			getIntermediatePoints({
				point1: last_coords,
				point2: first_coords,
				percent: (max_walk_dist / dist)
			}, function() {
				// do nothing
			});
		}
		start_location_num = current_location;
		callback(true);
	}
}

/**
 *
 * @param options
 * @param callback
 */
function getIntermediatePoints(options, callback) {
	if(options.num === undefined || options.num == null) {
		options.num = 0;
	}
	options.num++;
	var fraction = options.percent * options.num;
	if(fraction < 1) {
		var p1 = new LatLon(options.point1.latitude, options.point1.longitude);
		var p2 = new LatLon(options.point2.latitude, options.point2.longitude);
		var p = p1.intermediatePointTo(p2, fraction);
		addToLocations(p);
		getIntermediatePoints(options, callback);
	} else {
		callback(true);
	}
}

/**
 *
 * @param latlon
 * @param label
 */
function addToLocations(latlon, label) {
	var str = latlon.lat + "," + latlon.lon + ",";
	var coords = [latlon.lat, latlon.lon];
	if(label !== undefined && label != null) {
		str = str + label;
		coords.push(label);
	}
	if(coords_file !== undefined) {
		fs.appendFile(coords_file, str + "\n", function(err) {
			if(err) throw err;
		});
	}
	var loc = configCoords(coords);
	locations.push(loc);
	// check if closest to start point
	if(isClosestToStart(loc)) {
		current_location = (locations.length - 1);
	}
}

/**
 *
 * @param coords
 * @returns {{type: string, coords: {latitude: Number, longitude: Number}}}
 */
function configCoords(coords) {
	var loc = {
		"type": "coords",
		"coords": {
			"latitude": parseFloat(coords[0]),
			"longitude": parseFloat(coords[1])
		}
	};
	if(coords[2] !== undefined && coords[2] != null) {
		loc.label = coords[2];
	}
	return loc;
}

/**
 *
 * @param loc
 * @returns {boolean}
 */
function isClosestToStart(loc) {
	if(closest_to_start == null) {
		var dist = distance(loc.coords, location.coords);
		closest_to_start = {loc: loc, dist: dist};
		return true;
	} else {
		var dist = distance(loc.coords, location.coords);
		if(dist < closest_to_start.dist) {
			closest_to_start = {loc: loc, dist: dist};
			return true;
		} else {
			return false;
		}
	}
}

/**
 * Add some variation to location provided
 *
 * @param location
 * @returns {*}
 */
function tweakLocation(location) {
	var new_location = location;
	var lat_str = location.coords.latitude.toString();
	var lon_str = location.coords.longitude.toString();
	var lat_rand = rand(0, 99).toString();
	var lon_rand = rand(0, 99).toString();

	lat_str = lat_str.slice(0, -lat_rand.length) + lat_rand;
	lon_str = lon_str.slice(0, -lon_rand.length) + lon_rand;

	new_location.coords.latitude = parseFloat(lat_str);
	new_location.coords.longitude = parseFloat(lon_str);

	return new_location;
}

/**
 * Get distance between two points
 *
 * @param point1
 * @param point2
 * @returns {number}
 */
function distance(point1, point2) {
	var p1 = new LatLon(point1.latitude, point1.longitude);
	var p2 = new LatLon(point2.latitude, point2.longitude);

	return p1.distanceTo(p2); // in m
}

/**
 *
 * @param min
 * @param max
 * @returns {*}
 */
function rand(min, max) {
	return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 *
 * @param data
 * @param callback
 */
function processGetMapObjectsResponse(data, callback) {
	if(data !== undefined && data.map_cells !== undefined) {
		var cells = data.map_cells;
		var forts = [];
		for(var i in cells) {
			var cell = cells[i];
			if(cell.forts !== undefined && cell.forts !== null && cell.forts.length > 0) {
				for(var j in cell.forts) {
					forts.push(cell.forts[j]);
				}
			}
		}

		pokeAPI.sortLocations(forts, function(forts_sorted) {
			forts_in_path = forts_sorted;
			callback(true);
		});
	}
}

/**
 *
 * @param arr
 * @returns {number}
 */
function sumArray(arr) {
	var total = 0;
	if(arr.length > 0) {
		for(i in arr) {
			// TODO: check if numeric before adding
			total += arr[i];
		}
	}
	return total;
}