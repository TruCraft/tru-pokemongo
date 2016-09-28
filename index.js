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
				description: 'Have the process loop'
			}, {
				name: 'catch',
				alias: 'c',
				type: Boolean,
				description: 'Try to catch Pokemon; must be used with the loop (-l) flag'
			}, {
				name: 'scrap',
				alias: 's',
				type: Boolean,
				description: 'Scrap duplicate Pokemon (must have the "allow_scrap" parameter in the user config file)'
			}, {
				name: 'trash',
				alias: 't',
				type: Boolean,
				description: 'Trash items defined in user config file (trash_items parameter)'
			}, {
				name: 'inventory',
				alias: 'i',
				type: Boolean,
				description: 'Show inventory'
			}, {
				name: 'pokemon',
				alias: 'p',
				type: Boolean,
				description: 'Show Pokemon'
			}, {
				name: 'write',
				alias: 'w',
				type: String,
				typeLabel: '[underline]{filename}',
				description: 'Coordinates file to be written to the ./coords/ directory'
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

var doLoop = flags.loop || false;
var doCatch = flags.catch || false;
var doScrap = flags.scrap || false;
var doTrash = flags.trash || false;
var doShowInventory = flags.inventory || false;
var doShowPokemon = flags.pokemon || false;

var username = flags.username;
var write_file = flags.write;

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

// config files
var configsDir = __dirname + "/configs";
if(write_file !== undefined) {
	if(write_file != null) {
		var coordFilesDir = __dirname + "/coord_files/";
		var coords_file = coordFilesDir + write_file;
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
		showUsage("You must provide a filename with the write flag (-w)");
	}
}
var accountConfigFile = configsDir + "/" + username + ".json";

var account_config = [];

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
var interval_min = 5000;
var interval_max = 15000;
var interval;

var retry_wait = 10000;
var call_wait = 2500;

var poke_storage = 0;
var item_storage = 0;

var pokeball_counts = [];
var inventory_items = [];
var items_to_trash = [];
var incubators = [];
var eggs = [];

var pokemon_list = [];
var pokemon_grouped = [];
var best_pokemon = {};
var add_to_favorites = [];
var pokemon_to_scrap = [];

var break_loop = false;
var restart_wait_min = 10;
var restart_wait = (1000 * 60) * restart_wait_min;
var fail_count_restart = 0;

var perfect_score = (15 + 15 + 15);

var max_dist = 40;
var max_walk_dist = 20;

var fail_count = 0;

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
var closest_to_start = null;

init();

function init() {
	pokeAPI.init(username, password, location, provider, function(err, responses) {
		if(err) {
			myLog.error("From main:");
			myLog.error(err);
			myLog.error("Wait " + (retry_wait / 1000) + " seconds between retries");
			// wait between tries
			setTimeout(function() {
				init();
			}, retry_wait);
			return;
		} else {
			processHeartBeatResponses(responses, function() {
				if(locations.length <= 0) {
					if(responses.GET_MAP_OBJECTS !== undefined && responses.GET_MAP_OBJECTS.map_cells !== undefined) {
						processGetMapObjectsResponse(responses.GET_MAP_OBJECTS, function() {
							myLog.chat(forts_in_path.length + " Forts in this path");
							getPath({locations: forts_in_path}, function() {
								main();
							});
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
 *
 * @param wait
 * @param callback
 */
function getProfile(wait, callback) {
	setTimeout(function() {
		pokeAPI.GetProfile(function(err, profile) {
			if(err) {
				myLog.error("From main->pokeAPI.GetProfile:");
				myLog.error(err);
				myLog.error("Wait " + (retry_wait / 1000) + " seconds between retries");
				// wait between tries
				setTimeout(function() {
					getProfile(wait, callback);
				}, retry_wait);
			} else {
				poke_storage = profile.max_pokemon_storage;
				item_storage = profile.max_item_storage;
				myLog.info('Username: ' + profile.username);
				myLog.info('Poke Storage: ' + poke_storage);
				myLog.info('Item Storage: ' + item_storage);

				myLog.info('Pokecoin: ' + profile.currencies[0].amount);
				myLog.info('Stardust: ' + profile.currencies[1].amount);
				callback(true);
			}
		});
	}, wait);
}

/**
 * Main process
 */
function main() {
	myLog.info('Current location: ' + pokeAPI.playerInfo.locationName);
	myLog.info('lat/long/alt: : ' + pokeAPI.playerInfo.latitude + ' ' + pokeAPI.playerInfo.longitude + ' ' + pokeAPI.playerInfo.altitude);

	getProfile(call_wait, function() {
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
									fail_count_restart = 0;
									myLog.chat("\t\t######### Process restarting in " + restart_wait_min + " minutes #########");
									setTimeout(function() {
										init();
									}, restart_wait);
									return;
								} else {
									myLog.error("Wait " + (retry_wait / 1000) + " seconds between retries; fail_count_restart: " + fail_count_restart);
									setTimeout(function() {
										init();
									}, retry_wait);
									return;
								}
							}
						});
					}
				});
			});
		});
	});
}

/**
 * Run the loop to go to provided GPS coordinates
 *
 * @param callback
 */
function runLoop(callback) {
	if(!break_loop) {
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
 * Check locations for things nearby (Pokemon and Poke Stops)
 *
 * @param wait
 */
function runLocationChecks(wait) {
	setTimeout(function() {
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
						return;
					} else {
						processHeartBeatResponses(res, function() {
							if(res.GET_MAP_OBJECTS !== undefined && res.GET_MAP_OBJECTS.map_cells !== undefined) {
								var cells = res.GET_MAP_OBJECTS.map_cells;
								var forts = [];
								var pokemon_to_catch = [];
								for(var i in cells) {
									var cell = cells[i];
									if(cell.forts.length > 0) {
										forts.push(cell.forts);
									}

									if(cell.nearby_pokemons.length > 0) {
										for(var i in cell.nearby_pokemons) {
											myLog.warning("There is a " + pokeAPI.getPokemonInfo(cell.nearby_pokemons[i]).name + " near.");
										}
									}

									// get list of catchable pokemon
									if(cell.catchable_pokemons.length > 0) {
										for(var i in cell.catchable_pokemons) {
											myLog.attention(pokeAPI.getPokemonInfo(cell.catchable_pokemons[i]).name + " is close enough to catch");
											if(pokemon_to_catch.indexOf(cell.catchable_pokemons[i]) < 0) {
												pokemon_to_catch.push(cell.catchable_pokemons[i]);
											}
										}
									}
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
											myLog.info(pokemon_to_catch.length + " catchable pokemon nearby");
											catchPokemon({pokemon_list: pokemon_to_catch}, function() {
												addPokemonToFavorites(function() {
													// maybe do something
												});
											});
										});
									});
								});
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
			case "GET_HATCHED_EGGS":
				if(result.success) {
					if(result.pokemon_id.length > 0) {
						for(var j in result.pokemon_id) {
							var pokemon = {pokemon_id: result.pokemon_id[j]};
							myLog.success("\t" + pokeAPI.getPokemonInfo(pokemon).name + " hatched");
						}
						myLog.success("\t" + sumArray(result.experience_awarded) + " XP awarded");
						myLog.success("\t" + sumArray(result.candy_awarded) + " Candy awarded");
						myLog.success("\t" + sumArray(result.stardust_awarded) + " Stardust awarded");
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
			case "DOWNLOAD_SETTINGS":
				// not sure what to do with this... maybe nothing
				break;
			default:
				myLog.warning(i + " result not yet implemented: " + res[i].toString());
		}
	}

	callback(true);
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
			//myLog.info((incubator.target_km_walked - incubator.start_km_walked) + "km left to hatch egg");
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
function catchPokemon(options, callback) {
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
							catchPokemon(options, callback);
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
								getBallToUse(encounter_res, function(pokeball_id) {
									if(pokeball_id != null) {
										var hitPosition = 1;
										//var reticleSize = 1.950;
										var min = 1850;
										var max = 1950;
										var reticleSize = rand(min, max) / 1000;
										//var spinModifier = 1;
										min = 85;
										max = 100;
										var spinModifier = rand(min, max) / 100;
										myLog.chat("\t#### TRYING TO CATCH WITH POS: " + hitPosition + " RET: " + reticleSize + " SPIN: " + spinModifier + " BALL: " + pokeball_id);
										pokeAPI.CatchPokemon(pokemon, hitPosition, reticleSize, spinModifier, pokeball_id, function(catch_err, catch_res) {
											if(catch_err && catch_err != "No result") {
												myLog.warning("Unable to catch " + pokemon_name + "; ERROR: " + catch_err);
												setTimeout(function() {
													catchPokemon(options, callback);
												}, call_wait);
											} else {
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
													} else {
														myLog.warning(status_str + " " + pokemon_name);
														if(status == 0 || status == 2) {
															// add back to the list and try again
															options.pokemon_list.push(pokemon);
														}
													}
													if(catch_res.capture_award !== undefined && catch_res.capture_award != null) {
														myLog.success("\t" + sumArray(catch_res.capture_award.xp) + " XP awarded");
														myLog.success("\t" + sumArray(catch_res.capture_award.candy) + " Candy awarded");
														myLog.success("\t" + sumArray(catch_res.capture_award.stardust) + " Stardust awarded");
													}
													setTimeout(function() {
														catchPokemon(options, callback);
													}, call_wait);
												} else {
													myLog.warning("Unable to catch " + pokemon_name + "; status not defined (" + catch_res + ")");
													setTimeout(function() {
														catchPokemon(options, callback);
													}, call_wait);
												}
											}
										});
									} else {
										callback(options);
									}
								});
							} else {
								myLog.warning("There was a problem when trying to encounter pokemon " + pokemon_name + " (" + encounter_status_value + ")");
								// if pokemon inventory is full
								if(encounter_status_id == 7) {
									scrapPokemon(function(scrapped) {
										if(scrapped) {
											options.pokemon_list.push(pokemon);
											setTimeout(function() {
												catchPokemon(options, callback);
											}, call_wait);
										} else {
											myLog.info("Cannot catch - unable to scrap");
											callback(options);
										}
									});
								} else {
									myLog.warning(JSON.stringify(encounter_res));
									setTimeout(function() {
										catchPokemon(options, callback);
									}, call_wait);
								}
							}
						} else {
							myLog.warning("EncounterStatus is undefined when trying to encounter pokemon " + pokemon_name);
							myLog.warning(JSON.stringify(encounter_res));
							setTimeout(function() {
								catchPokemon(options, callback);
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
			myLog.info("\tProbability for " + pokeAPI.getItemInfo({item_id: prob.pokeball_type[i]}).name + ": " + prob_perc[i] + "%");
		}
	}
	var ball_to_use = null;
	for(var ballIndex in pokeball_counts) {
		if(ballIndex != 0) {
			var ballInt = parseInt(ballIndex);
			myLog.info("\t" + pokeball_counts[ballIndex] + " " + pokeAPI.getItemInfo({item_id: ballInt}).name + "s");
			if(pokeball_counts[ballIndex] != null && pokeball_counts[ballIndex] > 0) {
				if(ball_to_use === null) {
					ball_to_use = ballInt;
				} else if(prob_perc[ball_to_use] < 75) {
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
			for(var i in inventory_items) {
				var item = inventory_items[i];
				var item_name = pokeAPI.getItemInfo(item).name;
				var item_count = item.count;
				total += item_count;
				myLog.info(item_count + "x " + item_name + "s");
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
			trashItems(items, callback);
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
			for(var i in pokemon_list) {
				total++;
				var pokemon = pokemon_list[i];
				var score = pokemon.individual_attack + pokemon.individual_defense + pokemon.individual_stamina;
				var info_str = formatString(pokemon.info.name, (pokeAPI.getMaxPokemonNameLength() + 5)) + formatString("CP: " + pokemon.cp) + formatString("HP: " + pokemon.stamina + "/" + pokemon.stamina_max, 15) + formatString("AT: " + pokemon.individual_attack) + formatString("DE: " + pokemon.individual_defense) + formatString("ST: " + pokemon.individual_stamina) + "SCORE: " + formatString(score, 3) + "/" + formatString(perfect_score, 5);
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
function formatString(str, len) {
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
		myLog.info("\tSCRAPPING POKEMON: " + pokemon.info.name + " (" + pokemon_to_scrap.length + " remaining)");
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
	getPokeStopsNearby(options, function() {
		getPokeStops(options, function() {
			callback(options);
		});
	});
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
		myLog.chat("=== APPROACHING POKESTOP" + (lure ? " WITH LURE " : " ") + "===");
		pokeAPI.GetFort(fort.id, fort.latitude, fort.longitude, function(err, data) {
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
		callback(options.xp_earned);
	}
}

/**
 * Get Poke stops nearby
 *
 * @param options        should contain cellsNearby and pokeStops arrays
 * @param callback
 */
function getPokeStopsNearby(options, callback) {
	if(options.pokeStops === undefined) {
		options.pokeStops = [];
	}
	if(options.cellsNearby.length > 0) {
		options.forts = options.cellsNearby.pop();
		arePokeStopsNearby(options, function() {
			getPokeStopsNearby(options, callback);
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
function arePokeStopsNearby(options, callback) {
	if(options.pokeStops === undefined) {
		options.pokeStops = [];
	}
	if(options.forts.length > 0) {
		var fort = options.forts.pop();

		var fortLocation = {'latitude': fort.latitude, 'longitude': fort.longitude};
		var myPosition = {'latitude': location.coords.latitude, 'longitude': location.coords.longitude};
		var distanceToFort = distance(myPosition, fortLocation);

		//0.0248548 is the max distance we can be to go to a fort
		//fort.type 1 is a pokestop - 0 is a gym
		if(fort.type == 1) {
			// within 40 meters
			if(distanceToFort < max_dist) {
				options.pokeStops.push(fort);
				//myLog.attention(fortLocation.latitude + "," + fortLocation.longitude + " (" + fort.type + ") is CLOSE ENOUGH (" + distanceToFort + ")");
			} else {
				//myLog.attention(fortLocation.latitude + "," + fortLocation.longitude + " (" + fort.type + ") is too far away (" + distanceToFort + ")");
			}
		}
		arePokeStopsNearby(options, callback);
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