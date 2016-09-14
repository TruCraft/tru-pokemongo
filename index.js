#! /usr/bin/env node

'use strict';

const util = require('util');
const commandLineArgs = require('command-line-args');
const getUsage = require('command-line-usage');
const LatLon = require('geodesy').LatLonSpherical;

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

if(username == null) {
	showUsage("You must provide a username (-u)");
}

if(doCatch && !doLoop) {
	showUsage("The catch (-c) flag must be used with the loop flag (-l)");
}

var fs = require('fs');
var logger = require('tru-logger');
var mkdirp = require('mkdirp');
var PokemonGO = require('pokemon-go-node-api');

// using var so you can login with multiple users
var pokeAPI = new PokemonGO.Pokeio();

var statuses = {};
buildVarsFromProto();

var pokemon_name_max_len = 0;

for(var i in pokeAPI.pokemonlist) {
	if(pokeAPI.pokemonlist[i].name.length > pokemon_name_max_len) {
		pokemon_name_max_len = pokeAPI.pokemonlist[i].name.length;
	}
}

// config files
var configsDir = __dirname + "/configs";
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

var perfect_score = (15 + 15 + 15);

var max_dist = 40;

var current_location = -1;
//var config_locations = getLocations(account_config.locations);
var locations = [];
//var location = config_locations[0];
var location_num = 0;
var location = configCoords(account_config.start_point);

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
			getFortsNearPoint({wait: call_wait}, function(pokeStops) {
				getPath({locations: pokeStops}, function() {
					main();
				});
			});
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
				poke_storage = profile.poke_storage;
				item_storage = profile.item_storage;
				myLog.info('Username: ' + profile.username);
				myLog.info('Poke Storage: ' + poke_storage);
				myLog.info('Item Storage: ' + item_storage);

				var poke = 0;
				if(profile.currency[0].amount) {
					poke = profile.currency[0].amount;
				}

				myLog.info('Pokecoin: ' + poke);
				myLog.info('Stardust: ' + profile.currency[1].amount);
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
		/*pokeAPI.GetHatchedEggs(function(err, res) {
			console.log("HATCHED EGGS");
			console.log(err);
			console.log(res);
			//process.exit();
		});*/

		showInventory({wait: retry_wait, show: doShowInventory, trash: doTrash}, function() {
			showPokemon({wait: retry_wait, show: doShowPokemon}, function() {
				scrapPokemon({wait: retry_wait, scrap: doScrap}, function() {
					if(doLoop) {
						runLoop(function() {
							if(break_loop) {
								// start back up if the process exited
								break_loop = false;
								pokeAPI = new PokemonGO.Pokeio();
								myLog.chat("\t\t######### Process restarting in " + restart_wait_min + " minutes #########");
								setTimeout(function() {
									main();
								}, restart_wait);
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
		pokeAPI.Heartbeat(function(err, hb) {
			if(err) {
				myLog.error("From runLocationChecks->pokeAPI.Heartbeat:");
				myLog.error(err);
				break_loop = true;
				return;
			} else {
				current_location++;
				if(current_location >= locations.length) {
					current_location = 0;
				}
				location_num = current_location + 1;
				location = tweakLocation(locations[current_location]);
				pokeAPI.SetLocation(location, function(err, data) {
					if(err) {
						myLog.error("From runLocationChecks->pokeAPI.SetLocation:");
						myLog.error(err);
					} else {
						var label = "";
						if(location.label !== undefined) {
							label = location.label;
						}
						myLog.add("Changed location: " + data.latitude + "," + data.longitude + " (" + location_num + " / " + locations.length + ") " + label);

						if(hb != undefined && hb.cells != undefined) {
							var forts = [];
							var pokemon_to_catch = [];
							for(var i = hb.cells.length - 1; i >= 0; i--) {
								var cell = hb.cells[i];
								forts.push(cell.Fort);

								if(cell.NearbyPokemon[0]) {
									var pokemon = pokeAPI.pokemonlist[parseInt(cell.NearbyPokemon[0].PokedexNumber) - 1];
									myLog.warning('There is a ' + pokemon.name + ' near.');
								}

								// get list of catchable pokemon
								for(var j = cell.MapPokemon.length - 1; j >= 0; j--) {
									myLog.attention(pokeAPI.pokemonlist[parseInt(cell.MapPokemon[j].PokedexTypeId) - 1].name + " is close enough to catch");
									if(pokemon_to_catch.indexOf(cell.MapPokemon[j]) < 0) {
										pokemon_to_catch.push(cell.MapPokemon[j]);
									}
								}
							}
							myLog.info(pokemon_to_catch.length + " catchable pokemon nearby");
							catchPokemon(pokemon_to_catch, function() {
								checkForts(forts, function(items) {
									var total = items.length;
									showItemsAcquired(items, function() {
										if(total != null && total > 0) {
											showInventory({wait: call_wait, show: true, trash: doTrash}, function() {
												// maybe do something
											});
										}
									});
								});
							});
						}

					}
				});
			}
		});
	}, wait);
}

/**
 * Show the items acquired at a Poke Stop
 *
 * @param items
 * @param callback
 */
function showItemsAcquired(items, callback) {
	if(items.length > 0) {
		var item = items.pop();
		var id = item.item_id;
		var info = getItemInfo(id);
		var name = info.name;
		var count = item.item_count;

		myLog.success("\tAcquired " + count + "x " + name);
		showItemsAcquired(items, callback);
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
// TODO: upon catch, evaluate pokemon - favorite perfect ones
function catchPokemon(pokemon_list, callback) {
	if(doCatch) {
		if(pokemon_list.length > 0) {
			var pokemon = pokemon_list.pop();
			getPokeballCounts(function(counts) {
				if(counts[0] > 0) {
					var pokedexInfo = pokeAPI.pokemonlist[parseInt(pokemon.PokedexTypeId) - 1];
					myLog.chat('There is a ' + pokedexInfo.name + ' near!! I can try to catch it!');

					pokeAPI.EncounterPokemon(pokemon, function(err, dat) {
						if(err) {
							myLog.warning('Unable to encounter pokemon ' + pokedexInfo.name + " (" + err + ")");
							setTimeout(function() {
								catchPokemon(pokemon_list, callback);
							}, call_wait);
						} else {
							if(dat.EncounterStatus !== undefined) {
								var encounter_status = dat.EncounterStatus;
								if(encounter_status == 1 && dat.WildPokemon !== undefined && dat.WildPokemon != null) {
									myLog.chat('Encountered pokemon ' + pokedexInfo.name + '...');
									getBallToUse(counts, function(pokeball_id) {
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
											myLog.chat("\t\t#### TRYING TO CATCH WITH POS: " + hitPosition + " RET: " + reticleSize + " SPIN: " + spinModifier + " BALL: " + pokeball_id);
											pokeAPI.CatchPokemon(pokemon, hitPosition, reticleSize, spinModifier, pokeball_id, function(xerr, xdat) {
												if(xerr !== undefined && xerr != "No result") {
													myLog.warning("Unable to catch " + pokedexInfo.name + "; ERROR: " + xerr);
													setTimeout(function() {
														catchPokemon(pokemon_list, callback);
													}, call_wait);
												} else {
													if(xdat !== undefined && xdat.Status !== undefined) {
														var status = xdat.Status;
														if(statuses.catch[status] !== undefined) {
															var status_str = statuses.catch[status];
															if(status == 1) {
																myLog.success(status_str + " " + pokedexInfo.name);
															} else {
																myLog.warning(status_str + " " + pokedexInfo.name);
																if(status == 0 || status == 2) {
																	// add back to the list and try again
																	pokemon_list.push(pokemon);
																}
															}
															setTimeout(function() {
																catchPokemon(pokemon_list, callback);
															}, call_wait);
														} else {
															myLog.warning("Unable to catch " + pokedexInfo.name + "; status not accounted for (" + xdat + ")");
															setTimeout(function() {
																catchPokemon(pokemon_list, callback);
															}, call_wait);
														}
													} else {
														myLog.warning("Unable to catch " + pokedexInfo.name + "; status not defined (" + xdat + ")");
														setTimeout(function() {
															catchPokemon(pokemon_list, callback);
														}, call_wait);
													}
												}
											});
										} else {
											callback(true);
										}
									});
								} else {
									var encounter_status_string;
									if(statuses.encounter[encounter_status] !== undefined) {
										encounter_status_string = statuses.encounter[encounter_status];
									} else {
										encounter_status_string = encounter_status;
									}
									myLog.warning('There was a problem when trying to encounter pokemon' + pokedexInfo.name + " (" + encounter_status_string + ")");
									// if pokemon inventory is full
									if(encounter_status == 7) {
										scrapPokemon({wait: retry_wait, scrap: doScrap}, function(scrapped) {
											if(scrapped) {
												pokemon_list.push(pokemon);
												setTimeout(function() {
													catchPokemon(pokemon_list, callback);
												}, call_wait);
											} else {
												myLog.info("Cannot catch - unable to scrap");
												callback(true);
											}
										});
									} else {
										console.log(dat);
										setTimeout(function() {
											catchPokemon(pokemon_list, callback);
										}, call_wait);
									}
								}
							} else {
								myLog.warning('EncounterStatus is undefined when trying to encounter pokemon' + pokedexInfo.name);
								console.log(dat);
								setTimeout(function() {
									catchPokemon(pokemon_list, callback);
								}, call_wait);
							}
						}
					});
				} else {
					myLog.warning("Out of Poke Balls :(");
					callback(true);
				}
			});
		} else {
			callback(true);
		}
	} else {
		myLog.info("Not catching - doCatch flag is set to false");
		callback(true);
	}
}

/**
 * Get the Poke ball to use
 *
 * @param pokeball_counts
 * @param callback
 */
function getBallToUse(pokeball_counts, callback) {
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
	if(options.show || options.trash) {
		setTimeout(function() {
			pokeAPI.GetInventory(function(err, data) {
				if(err) {
					myLog.error("From showInventory->pokeAPI.GetInventory:");
					myLog.error(err);
					myLog.error("Wait " + (retry_wait / 1000) + " seconds between retries");
					showInventory(options, callback);
				} else {
					var items_to_trash = {};
					var total = 0;
					//console.log(util.inspect(data, {showHidden: false, depth: null}))
					for(var i in data.inventory_delta.inventory_items) {
						var entry = data.inventory_delta.inventory_items[i].inventory_item_data;
						if(entry.item != null) {
							var item = entry.item;
							var itemID = item.item_id;
							var itemInfo = getItemInfo(itemID);
							var itemName = itemInfo.name;
							var itemCount = item.count;
							if(itemCount != null && itemName != "Incubator (Unlimited)") {
								total += itemCount;
							}
							if(options.show) {
								myLog.info(itemCount + "x " + itemName + "s");
							}

							if(trash_items != null && trash_items.indexOf(itemName) > -1 && itemCount != null) {
								items_to_trash[itemID] = itemCount;
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
				}
			});
		}, options.wait);
	} else {
		callback(true);
	}
}

function trashItems(items, callback) {
	if(Object.keys(items).length > 0) {
		for(var id in items) {
			pokeAPI.DropItem(parseInt(id), parseInt(items[id]), function(err, dat) {
				var itemInfo = getItemInfo(id);
				var itemName = itemInfo.name;
				if(err) {
					myLog.error(err);
				} else {

					if(dat !== undefined && dat.result !== undefined && dat.result != null) {
						myLog.info(dat.result);
						var count = 0;
						if(dat.new_count != null) {
							count = dat.new_count;
						}
						myLog.info(count + " " + itemName + "s left");
					} else {
						console.log(dat);
					}
				}
				delete items[id];
				trashItems(items, callback);
			});
		}
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
					myLog.error("Wait " + (wait / 1000) + " seconds between retries");
					getPokemon(options, callback);
				} else {
					options.inventory = data.inventory_delta.inventory_items;
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

			if(entry.pokemon != null) {
				var pokemon = entry.pokemon;
				if(pokemon.is_egg == null) {
					var pokemonId = parseInt(pokemon.pokemon_id);
					var pokemonInfo = pokeAPI.pokemonlist[pokemonId - 1];
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
// TODO: favorite perfect pokemon that are not already favorite
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
				/*pokeAPI.FavoritePokemon(pokemon.id, true, function() {
					console.log("WOW, it worked...");
				});*/
				var score = pokemon.individual_attack + pokemon.individual_defense + pokemon.individual_stamina;
				var info_str = formatString(pokemon.info.name, (pokemon_name_max_len + 5)) + formatString("CP: " + pokemon.cp) + formatString("HP: " + pokemon.stamina + "/" + pokemon.stamina_max, 15) + formatString("AT: " + pokemon.individual_attack) + formatString("DE: " + pokemon.individual_defense) + formatString("ST: " + pokemon.individual_stamina) + "SCORE: " + formatString(score, 3) + "/" + formatString(perfect_score, 5);
				if(score == perfect_score) {
					myLog.success("############### PERFECT ###################");
					// add to favorites if not already
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
				callback(true);
			}
		}
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
			//console.log("WON'T SCRAP - PERFECT");
		} else if(pokemon.favorite) {
			//console.log("WON'T SCRAP - FAVORITE");
		} else if(options.best_pokemon[pokemon_id] !== undefined && options.best_pokemon[pokemon_id].id == pokemon.id) {
			//console.log("WON'T SCRAP - BEST");
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
				console.log(dat);
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
			myLog.error("Wait " + (retry_wait / 1000) + " seconds between retries");
			// wait between tries
			setTimeout(function() {
				getPokeballCounts(callback);
			}, retry_wait);
			return;
		}
		for(var i in data.inventory_delta.inventory_items) {
			var entry = data.inventory_delta.inventory_items[i].inventory_item_data;
			if(entry.item != null) {
				var item = entry.item;
				var itemID = item.item_id;
				var itemInfo = getItemInfo(itemID);
				var itemName = itemInfo.name;
				var itemCount = item.count;
				if(itemName.indexOf("ball") >= 0) {
					myLog.info(itemCount + " " + itemName + "s");
					pokeballs[0] += itemCount;
					pokeballs[itemID] = itemCount;
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
			callback(options.items);
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
	if(options.pokeStops.length > 0) {
		var fort = options.pokeStops.pop();
		myLog.chat("=== APPROACHING POKESTOP ===");
		pokeAPI.GetFort(fort.FortId, fort.Latitude, fort.Longitude, function(err, data) {
			if(err) {
				myLog.error("From checkForts->pokeAPI.GetFort:");
				myLog.error(err);
				options.pokeStops.push(fort);
			} else {
				if(data != undefined) {
					if(data.experience_awarded !== undefined && data.experience_awarded !== null) {
						myLog.success(data.experience_awarded + " XP earned");
					}
					if(data.result == 1 && data.items_awarded.length > 0) {
						for(var itemIndex = 0; itemIndex < data.items_awarded.length; itemIndex++) {
							var item = data.items_awarded[itemIndex];
							options.items.push(item);
						}
					} else if(data.result != 1) {
						var reason = ["NO RESULT SET", "SUCCESS", "OUT OF RANGE", "IN COOLDOWN PERIOD", "INVENTORY FULL"];
						myLog.warning(reason[data.result]);
					}
				}
			}
			getPokeStops(options, callback);
		});
	} else {
		callback(true);
	}
}

/**
 * Get Poke stops nearby
 *
 * @param options 		should contain cellsNearby and pokeStops arrays
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

		var fortLocation = {'latitude': fort.Latitude, 'longitude': fort.Longitude};
		var myPosition = {'latitude': location.coords.latitude, 'longitude': location.coords.longitude};
		var distanceToFort = distance(myPosition, fortLocation);

		//0.0248548 is the max distance we can be to go to a fort
		//fort.FortType 1 is a pokestop - 0 is a gym
		if(fort.FortType == 1) {
			// whithin 40 meters
			if(distanceToFort < max_dist) {
				options.pokeStops.push(fort);
				//myLog.attention(fortLocation.latitude + "," + fortLocation.longitude + " (" + fort.FortType + ") is CLOSE ENOUGH (" + distanceToFort + ")");
			} else {
				//myLog.attention(fortLocation.latitude + "," + fortLocation.longitude + " (" + fort.FortType + ") is too far away (" + distanceToFort + ")");
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

		//fort.FortType 1 is a pokestop - 0 is a gym
		if(fort.FortType == 1) {
			options.pokeStops.push(fort);
		}
		arePokeStopsInView(options, callback);
	} else {
		callback(true);
	}
}

/**
 * Get and format locations contained in user config
 *
 * @param config_locations
 * @returns {Array}
 */
// TODO: have sets of coordinates defined and rotate between sets on failure and auto-reset
function getLocations(config_locations) {
	var _locations = [];
	if(config_locations !== undefined && config_locations != null && config_locations.coords !== undefined) {
		for(var i in config_locations.coords) {
			var location = {
				"type": "coords",
				"coords": {
					"latitude": config_locations.coords[i][0],
					"longitude": config_locations.coords[i][1]
				}
			};
			if(config_locations.coords[i][2] !== undefined) {
				location.label = config_locations.coords[i][2];
			}
			_locations.push(location);
		}
	}
	return _locations;
}

function getPath(options, callback) {
	if(options.locations.length > 0) {
		var location = options.locations.shift();
		var point = new LatLon(location.Latitude, location.Longitude);
		if(options.last_location === undefined || options.last_location == null) {
			options.first_location = location;
			options.last_location = location;
			addToLocations(point, "Poke Stop");
			getPath(options, callback);
		} else {
			var last_coords = {latitude: options.last_location.Latitude, longitude: options.last_location.Longitude};
			var current_coords = {latitude: location.Latitude, longitude: location.Longitude};
			var dist = distance(last_coords, current_coords);
			if(dist > max_dist) {
				//console.log("Too far between points - need to add points between (" + dist + ")");
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
		var last_coords = {latitude: options.last_location.Latitude, longitude: options.last_location.Longitude};
		var first_coords = {latitude: options.first_location.Latitude, longitude: options.first_location.Longitude};
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
	//console.log(latlon.lat + "," + latlon.lon + ",");
	var coords = [latlon.lat, latlon.lon];
	if(label !== undefined && label != null) {
		coords.push(label);
	}
	var loc = configCoords(coords);
	locations.push(loc);
}

function configCoords(coords) {
	var location = {
		"type": "coords",
		"coords": {
			"latitude": coords[0],
			"longitude": coords[1]
		}
	};
	if(coords[2] !== undefined && coords[2] != null) {
		location.label = coords[2];
	}
	return location;
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

/**
 * Get item info
 *
 * @param id
 * @returns {*}
 */
function getItemInfo(id) {
	if(id === undefined) {
		throw "id not defined in getItemInfo";
	}

	for(var i in pokeAPI.itemlist) {
		if(pokeAPI.itemlist[i].id == id) {
			return pokeAPI.itemlist[i];
		}
	}
}

function buildVarsFromProto() {
	if(statuses.encounter === undefined) {
		statuses.encounter = {};
	}
	if(statuses.catch === undefined) {
		statuses.catch = {};
	}

	var obj = pokeAPI.pokemonProto.ResponseEnvelop.EncounterResponse.Status;
	for(i in obj) {
		var str = i.replace(/_/g, " ").toLowerCase();
		statuses.encounter[obj[i]] = str;
	}

	obj = pokeAPI.pokemonProto.ResponseEnvelop.CatchPokemonResponse.CatchStatus;
	for(i in obj) {
		var str = i.replace(/_/g, " ").toLowerCase();
		statuses.catch[obj[i]] = str;
	}
}

function getFortsNearPoint(options, callback) {
	setTimeout(function() {
		pokeAPI.Heartbeat(function(err, hb) {
			if(err) {
				myLog.error("From runLocationChecks->pokeAPI.Heartbeat:");
				myLog.error(err);
				// TODO: retry?
			} else {
				if(hb != undefined && hb.cells != undefined) {
					options.cellsNearby = [];
					for(var i = hb.cells.length - 1; i >= 0; i--) {
						var cell = hb.cells[i];
						options.cellsNearby.push(cell.Fort);
					}

					getPokeStopsInView(options, function() {
						options.pokeStops.sort(dynamicSortMultiple("Latitude", "Longitude"));
						callback(options.pokeStops);
					});
				}
			}
		});
	}, options.wait);
}

function dynamicSort(property) {
	var sortOrder = 1;
	if(property[0] === "-") {
		sortOrder = -1;
		property = property.substr(1);
	}
	return function (a,b) {
		var result = (a[property] < b[property]) ? -1 : (a[property] > b[property]) ? 1 : 0;
		return result * sortOrder;
	}
}

function dynamicSortMultiple() {
	/*
	 * save the arguments object as it will be overwritten
	 * note that arguments object is an array-like object
	 * consisting of the names of the properties to sort by
	 */
	var props = arguments;
	return function (obj1, obj2) {
		var i = 0, result = 0, numberOfProperties = props.length;
		/* try getting a different result from 0 (equal)
		 * as long as we have extra properties to compare
		 */
		while(result === 0 && i < numberOfProperties) {
			result = dynamicSort(props[i])(obj1, obj2);
			i++;
		}
		return result;
	}
}