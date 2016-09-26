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
var interval_min = 10000;
var interval_max = 30000;
var interval;

var retry_wait = 10000;
var call_wait = 2500;

var poke_storage = 0;
var item_storage = 0;

var break_loop = false;
var restart_wait_min = 10;
var restart_wait = (1000 * 60) * restart_wait_min;
var fail_count_restart = 0;

var perfect_score = (15 + 15 + 15);

var max_dist = 40;

var fail_count = 0;

var current_location = -1;
var locations = [];
var pokestop_locations = [];
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
	pokeAPI.init(username, password, location, provider, function(err) {
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
			if(locations.length <= 0) {
				getFortsNearPoint({wait: call_wait}, function(pokeStops) {
					getPath({locations: pokeStops}, function() {
						myLog.chat(pokestop_locations.length + " Poke Stops in this path");
						main();
					});
				});
			} else {
				myLog.chat(pokestop_locations.length + " Poke Stops in this path");
				main();
			}
		}
	});
}

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
			showPokemon({wait: retry_wait, show: doShowPokemon}, function() {
				scrapPokemon({wait: retry_wait, scrap: doScrap}, function() {
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
					var dist = distance(previous_location.coords, location.coords);
					total_distance += dist; // in meters
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
						showHeartBeatResponses(res, function() {
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
											catchPokemon({pokemon_list: pokemon_to_catch}, function(options) {
												addPokemonToFavorites(options, function() {
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

function showHeartBeatResponses(res, callback) {
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
						myLog.success("\t" + result.candy_earned_count + " " + pokeAPI.getPokemonFamilyName(result.family_candy_id) + " Candy earned");
					}
				}
				break;
			case "GET_INVENTORY":
				// get ball counts here to replace the getPokeballCounts method
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
 * Show the items acquired at a Poke Stop
 *
 * @param items
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
 * @param pokemon_list
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
			getPokeballCounts(function(counts) {
				if(counts[0] > 0) {
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
									getBallToUse(encounter_res, counts, function(pokeball_id) {
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
													if(catch_res !== undefined && catch_res.status !== undefined) {
														var status = catch_res.status;
														var status_str = pokeAPI.getCatchStatus(status);
														if(status == 1) {
															myLog.success(status_str + " " + pokemon_name + " :: " + pokemon_stats_string);
															if(pokemonScore == perfect_score) {
																queuePokemonToFavorite(options, {
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
										scrapPokemon({wait: retry_wait, scrap: doScrap}, function(scrapped) {
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
			});
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
 * @param pokemon_data
 * @param pokeball_counts
 * @param callback
 */
function getBallToUse(encounter_result, pokeball_counts, callback) {
	//encounter_result.capture_probability
	//encounter_result.capture_probability.pokeball_type
	//encounter_result.capture_probability.capture_probability
	var i = 0;
	for(var ballIndex in pokeball_counts) {
		i++;
		if(ballIndex != 0) {
			if(pokeball_counts[ballIndex] != null && pokeball_counts[ballIndex] > 0) {
				callback(parseInt(ballIndex));
				return;
			}

			if(i > pokeball_counts.length) {
				callback(null);
			}
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
		setTimeout(function() {
			pokeAPI.GetInventory(function(err, data) {
				if(err) {
					myLog.error("From showInventory->pokeAPI.GetInventory:");
					myLog.error(err);
					fail_count++;
					if(fail_count > 10) {
						process.exit();
					}
					myLog.error("Wait " + (retry_wait / 1000) + " seconds between retries; fail_count: " + fail_count);
					showInventory(options, callback);
				} else {
					fail_count = 0;
					var items_to_trash = [];
					var total = 0;
					for(var i in data) {
						var entry = data[i].inventory_item_data;
						if(entry.player_stats !== null) {
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
						if(entry.item != null) {
							var item = entry.item;
							var itemInfo = pokeAPI.getItemInfo(item);
							var itemName = itemInfo.name;
							var itemCount = item.count;
							if(itemCount != null && itemName != "Incubator (Unlimited)") {
								total += itemCount;
							}
							if(options.show) {
								myLog.info(itemCount + "x " + itemName + "s");
							}

							if(trash_items != null && trash_items.indexOf(itemName) > -1 && itemCount > 0) {
								items_to_trash.push({item_id: item.item_id, count: itemCount});
							}
						}
					}
					if(options.show) {
						myLog.info("######### " + total + " / " + item_storage + " items #########");
					}
					if(options.trash) {
						trashItems(items_to_trash, function() {
							callback(true);
						});
					} else {
						callback(true);
					}

					if(options.stats) {
						showPlayerStats();
					}
				}
			});
		}, options.wait);
	} else {
		callback(true);
	}
}

function showPlayerStats() {
	/*{ level: 21,
	 experience: Long { low: 292764, high: 0, unsigned: false },
	 prev_level_xp: Long { low: 210000, high: 0, unsigned: false },
	 next_level_xp: Long { low: 335000, high: 0, unsigned: false },
	 km_walked: 104.00293731689453,
	 pokemons_encountered: 992,
	 unique_pokedex_entries: 78,
	 pokemons_captured: 870,
	 evolutions: 47,
	 poke_stop_visits: 1019,
	 pokeballs_thrown: 1901,
	 eggs_hatched: 41,
	 big_magikarp_caught: 6,
	 battle_attack_won: 78,
	 battle_attack_total: 87,
	 battle_defended_won: null,
	 battle_training_won: 56,
	 battle_training_total: 73,
	 prestige_raised_total: 7534,
	 prestige_dropped_total: 61500,
	 pokemon_deployed: 41,
	 pokemon_caught_by_type:
	 { buffer: <Buffer 08 01 10 80 80 80 80 b0 83 92 b2 14 32 06 08 06 12 02 08 01 a2 06 b0 b0 01 08 01 12 aa b0 01 10 cd f0 bf 8b f3 2a 1a 4b 1a 49 0a 47 09 45 6e 74 18 de ... >,
	 offset: 19832,
	 markedOffset: -1,
	 limit: 19853,
	 littleEndian: true,
	 noAssert: false },
	 small_rattata_caught: 10 }*/
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
						myLog.warning("There was a problem trashing " + itemName + "s: " + pokeAPI.getRecycleItemResult(data.result));
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
 * Get Pokemon currently owned by user
 *
 * @param options
 * @param callback
 */
function getPokemon(options, callback) {
	if(options.inventory == undefined || options.inventory == null) {
		setTimeout(function() {
			pokeAPI.GetInventory(function(err, data) {
				if(err) {
					myLog.error("From getPokemon->pokeAPI.GetInventory:");
					myLog.error(err);
					fail_count++;
					if(fail_count > 10) {
						process.exit();
					}
					myLog.error("Wait " + (options.wait / 1000) + " seconds between retries; fail_count: " + fail_count);
					getPokemon(options, callback);
				} else {
					fail_count = 0;
					options.inventory = data;
					getPokemon(options, callback);
				}
			});
		}, options.wait);
	} else {
		if(options.pokemon_list == undefined || options.pokemon_list == null) {
			options.pokemon_list = [];
		}
		if(options.inventory.length > 0) {
			var entry = options.inventory.pop().inventory_item_data;

			if(entry.pokemon_data != null) {
				var pokemon = entry.pokemon_data;
				if(!pokemon.is_egg) {
					var pokemonId = parseInt(pokemon.pokemon_id);
					var pokemonInfo = pokeAPI.getPokemonInfo(pokemon);
					pokemon.info = pokemonInfo;
					if(options.grouped !== undefined && options.grouped) {
						if(options.pokemon_list[pokemonId] === undefined) {
							options.pokemon_list[pokemonId] = [];
						}
						options.pokemon_list[pokemonId].push(pokemon);
					} else {
						options.pokemon_list.push(pokemon);
					}

					var score = pokemon.individual_attack + pokemon.individual_defense + pokemon.individual_stamina;
					if(options.best_pokemon === undefined || options.best_pokemon == null) {
						options.best_pokemon = {};
					}
					if(options.best_pokemon[pokemonId] === undefined) {
						options.best_pokemon[pokemonId] = pokemon;
					} else {
						var current_best = options.best_pokemon[pokemonId];
						var current_best_score = current_best.individual_attack + current_best.individual_defense + current_best.individual_stamina;
						if(score > current_best_score) {
							options.best_pokemon[pokemonId] = pokemon;
						} else if(score == current_best_score) {
							if(pokemon.cp > current_best.cp) {
								options.best_pokemon[pokemonId] = pokemon;
							} else if(pokemon.cp == current_best.cp) {
								if(pokemon.stamina_max > current_best.stamina_max) {
									options.best_pokemon[pokemonId] = pokemon;
								}
							}
						}
					}
				}
			}
			getPokemon(options, callback);
		} else {
			callback(options.pokemon_list);
		}
	}
}

/**
 * Show Pokemon owned by user
 *
 * @param options
 * @param callback
 */
function showPokemon(options, callback) {
	if(options.show) {
		if(options.pokemon_list === undefined) {
			getPokemon(options, function(pokemon_list) {
				options.pokemon_list = pokemon_list;
				showPokemon(options, callback);
			});
		} else {
			if(options.total === undefined || options.total == null) {
				options.total = 0;
			}
			if(options.pokemon_list.length > 0) {
				options.total++;
				var pokemon = options.pokemon_list.pop();
				var score = pokemon.individual_attack + pokemon.individual_defense + pokemon.individual_stamina;
				var info_str = formatString(pokemon.info.name, (pokeAPI.getMaxPokemonNameLength() + 5)) + formatString("CP: " + pokemon.cp) + formatString("HP: " + pokemon.stamina + "/" + pokemon.stamina_max, 15) + formatString("AT: " + pokemon.individual_attack) + formatString("DE: " + pokemon.individual_defense) + formatString("ST: " + pokemon.individual_stamina) + "SCORE: " + formatString(score, 3) + "/" + formatString(perfect_score, 5);
				if(score == perfect_score) {
					if(pokemon.favorite) {
						myLog.success("############### PERFECT & FAVORITE ###################");
					} else {
						myLog.success("############### PERFECT ###################");
						// add to favorites if not already
						queuePokemonToFavorite(options, pokemon);
					}
					myLog.success(info_str);
				} else if(pokemon.favorite) {
					myLog.chat("############### FAVORITE ###################");
					myLog.chat(info_str);
				} else {
					myLog.info(info_str);
				}
				showPokemon(options, callback);
			} else {
				myLog.info("######### " + options.total + " / " + poke_storage + " pokemon #########");
				addPokemonToFavorites(options, function() {
					callback(true);
				});
			}
		}
	} else {
		callback(true);
	}
}

function queuePokemonToFavorite(options, pokemon) {
	if(options.add_to_favorites === undefined || options.add_to_favorites == null) {
		options.add_to_favorites = [];
	}
	if(pokemon.info === undefined || pokemon.info == null) {
		pokemon.info = pokeAPI.pokemonlist[pokemon.pokemon_id - 1];
	}
	options.add_to_favorites.push(pokemon);
}

function addPokemonToFavorites(options, callback) {
	if(options.add_to_favorites !== undefined && options.add_to_favorites != null && options.add_to_favorites.length > 0) {
		var pokemon = options.add_to_favorites.pop();
		pokeAPI.SetFavoritePokemon(pokemon.id, true, function(err, data) {
			if(err) {
				myLog.error("From addPokemonToFavorites->pokeAPI.SetFavoritePokemon:");
				myLog.error(err);
				myLog.error("Wait " + (retry_wait / 1000) + " seconds between retries");
				addPokemonToFavorites(options, callback);
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
				addPokemonToFavorites(options, callback);
			}
		});
	} else {
		callback(true);
	}
}

/**
 * Send extra Pokemon to the meat grinder
 *
 * @param options
 * @param callback
 */
function scrapPokemon(options, callback) {
	if(options.scrap) {
		if(allow_scrap) {
			options.grouped = true;
			getPokemon(options, function() {
				getPokemonToScrap(options, function() {
					myLog.chat("Will try to scrap " + options.pokemon_to_scrap.length + " pokemon");
					transferPokemon(options.pokemon_to_scrap, function() {
						callback(true);
					});
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
 * @param options
 * @param callback
 */
function getPokemonToScrap(options, callback) {
	if(options.pokemon_to_scrap === undefined || options.pokemon_to_scrap == null) {
		options.pokemon_to_scrap = [];
	}
	if(options.pokemon_grouped !== undefined && options.pokemon_grouped != null && options.pokemon_grouped.length > 0) {
		var pokemon = options.pokemon_grouped.pop();
		var pokemon_id = parseInt(pokemon.pokemon_id);
		var score = pokemon.individual_attack + pokemon.individual_defense + pokemon.individual_stamina;

		if(score == perfect_score) {
			//myLog.info("WON'T SCRAP - PERFECT");
		} else if(pokemon.favorite) {
			//myLog.info("WON'T SCRAP - FAVORITE");
		} else if(options.best_pokemon[pokemon_id] !== undefined && options.best_pokemon[pokemon_id].id == pokemon.id) {
			//myLog.info("WON'T SCRAP - BEST");
		} else {
			options.pokemon_to_scrap.push(pokemon);
		}
		getPokemonToScrap(options, callback);
	} else {
		if(options.pokemon_list.length > 0) {
			options.pokemon_grouped = options.pokemon_list.pop();
			getPokemonToScrap(options, callback);
		} else {
			callback(true);
		}
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
 * @param pokemon_list
 * @param callback
 */
function transferPokemon(pokemon_list, callback) {
	if(pokemon_list.length > 0) {
		var pokemon = pokemon_list.pop();
		myLog.info("\tSCRAPPING POKEMON: " + pokemon.info.name + " (" + pokemon_list.length + " remaining)");
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
					transferPokemon(pokemon_list, callback);
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
 * Get count of different Poke balls
 *
 * @param callback
 */
function getPokeballCounts(callback) {
	pokeAPI.GetInventory(function(err, data) {
		var pokeballs = [];
		pokeballs[0] = 0;
		if(err) {
			myLog.error("From getPokeballCounts->pokeAPI.GetInventory:");
			myLog.error(err);
			fail_count++;
			if(fail_count > 10) {
				process.exit();
			}
			myLog.error("Wait " + (retry_wait / 1000) + " seconds between retries; fail_count: " + fail_count);
			// wait between tries
			setTimeout(function() {
				getPokeballCounts(callback);
			}, retry_wait);
			return;
		} else {
			fail_count = 0;
		}
		for(var i in data) {
			var entry = data[i].inventory_item_data;
			if(entry.item != null) {
				var item = entry.item;
				var itemName = pokeAPI.getItemInfo(item).name;
				var itemCount = item.count;
				if(itemName.indexOf("Ball") >= 0) {
					myLog.info(itemCount + " " + itemName + "s");
					pokeballs[0] += itemCount;
					pokeballs[item.item_id] = itemCount;
				}
			}
		}
		myLog.info(pokeballs[0] + " total balls");
		// wait between calls
		setTimeout(function() {
			callback(pokeballs);
		}, call_wait);
	});
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

function getPokeStopsInView(options, callback) {
	if(options.pokeStops === undefined) {
		options.pokeStops = [];
	}
	if(options.cellsNearby.length > 0) {
		options.forts = options.cellsNearby.pop();
		arePokeStopsInView(options, function() {
			getPokeStopsInView(options, callback);
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
			// whithin 40 meters
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

function arePokeStopsInView(options, callback) {
	if(options.pokeStops === undefined) {
		options.pokeStops = [];
	}
	if(options.forts.length > 0) {
		var fort = options.forts.pop();

		//fort.type 1 is a pokestop - 0 is a gym
		if(fort.type == 1) {
			pokestop_locations.push(fort);
			options.pokeStops.push(fort);
		}
		arePokeStopsInView(options, callback);
	} else {
		callback(true);
	}
}

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
			if(dist > max_dist) {
				//myLog.info("Too far between points - need to add points between (" + dist + ")");
				getIntermediatePoints({
					point1: last_coords,
					point2: current_coords,
					percent: (max_dist / dist)
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
		if(dist > max_dist) {
			getIntermediatePoints({
				point1: last_coords,
				point2: first_coords,
				percent: (max_dist / dist)
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
	var d = p1.distanceTo(p2); // in m

	return d;
}

function rand(min, max) {
	return Math.floor(Math.random() * (max - min + 1)) + min;
}

function getFortsNearPoint(options, callback) {
	setTimeout(function() {
		pokeAPI.Heartbeat(function(err, res) {
			if(err) {
				myLog.error("From getFortsNearPoint->pokeAPI.Heartbeat:");
				myLog.error(err);
				// TODO: retry?
			} else {
				if(res.GET_MAP_OBJECTS !== undefined && res.GET_MAP_OBJECTS.map_cells !== undefined) {
					var cells = res.GET_MAP_OBJECTS.map_cells;
					options.cellsNearby = [];
					for(var i in cells) {
						var cell = cells[i];
						options.cellsNearby.push(cell.forts);
					}

					getPokeStopsInView(options, function() {
						options.pokeStops.sort(pokeAPI.dynamicSortMultiple("latitude", "longitude"));
						callback(options.pokeStops);
					});
				}
			}
		});
	}, options.wait);
}

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