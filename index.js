#! /usr/bin/env node

'use strict';

const util = require('util');
const commandLineArgs = require('command-line-args');
const getUsage = require('command-line-usage');

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
				description: 'Try to catch Pokemon'
			}, {
				name: 'scrap',
				alias: 's',
				type: Boolean,
				description: 'Scrap duplicate Pokemon (must have the "allow_scrap" parameter in the user config file)'
			}, {
				name: 'username',
				alias: 'u', type: String,
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

var flags = commandLineArgs(optionDefinitions.optionList);

var doLoop = flags.loop || false;
var doCatch = flags.catch || false;
var doScrap = flags.scrap || false;

var username = flags.username;

if(username == null) {
	showUsage("You must provide a username (-u)");
}

var fs = require('fs');
var logger = require('tru-logger');
var mkdirp = require('mkdirp');
var PokemonGO = require('pokemon-go-node-api');

// using var so you can login with multiple users
var pokeAPI = new PokemonGO.Pokeio();

// config files
var configsDir = __dirname + "/configs";
//var configFile = configsDir + "/config.json";
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

var current_location = 0;
var locations = getLocations(account_config.locations);
var location = locations[current_location];
var num_locations = locations.length;
var location_num = 0;

var interval_obj;
var interval_min = 10000;
var interval_max = 30000;
var interval;

var retry_wait = 10000;
var call_wait = 3000;

var poke_storage = 0;
var item_storage = 0;

var break_loop = false;
var restart_wait_min = 10;
var restart_wait = (1000 * 60) * restart_wait_min;

startProcess();

function startProcess() {
	pokeAPI.init(username, password, location, provider, function(err) {
		if(err) {
			myLog.error("From startProcess:");
			myLog.error(err);
			myLog.error("Wait " + (retry_wait / 1000) + " seconds between retries");
			// wait between tries
			setTimeout(function() {
				startProcess();
			}, retry_wait);
			return;
		}

		myLog.info('Current location: ' + pokeAPI.playerInfo.locationName);
		myLog.info('lat/long/alt: : ' + pokeAPI.playerInfo.latitude + ' ' + pokeAPI.playerInfo.longitude + ' ' + pokeAPI.playerInfo.altitude);

		pokeAPI.GetProfile(function(err, profile) {
			if(err) {
				myLog.error("From startProcess->pokeAPI.GetProfile:");
				myLog.error(err);
				myLog.error("Wait " + (retry_wait / 1000) + " seconds between retries");
				// wait between tries
				setTimeout(function() {
					startProcess();
				}, retry_wait);
				return;
			}

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

			showInventory(retry_wait, function() {
				showPokemon(retry_wait, function() {
					if(doLoop) {
						// wait to start
						setTimeout(function() {
							runLoop(function() {
								if(break_loop) {
									// start back up if the process exited
									break_loop = false;
									pokeAPI = new PokemonGO.Pokeio();
									myLog.chat("\t\t######### Process restarting in " + restart_wait_min + " minutes #########");
									setTimeout(startProcess(), restart_wait);
									//throw "######### Something is wrong - stopping #########";
								}
							});
						}, call_wait);
					}
				});
			});
		});
	});
}

function runLoop(callback) {
	if(!break_loop) {
		runLocationChecks(call_wait);
		interval = Math.floor((Math.random() * interval_max) + interval_min);
		clearInterval(interval_obj);
		myLog.info("Wait interval " + (interval / 1000) + " seconds");
		interval_obj = setInterval(runLoop, interval, callback);
	} else {
		clearInterval(interval_obj);
		callback(true);
	}
}

function runLocationChecks(wait) {
	setTimeout(function() {
		pokeAPI.Heartbeat(function(err, hb) {
			if(err) {
				myLog.error("From runLocationChecks->pokeAPI.Heartbeat:");
				myLog.error(err);
				//myLog.error("Wait " + (retry_wait / 1000) + " seconds between retries");
				// wait between tries
				//runLocationChecks(retry_wait);
				break_loop = true;
				return;
			} else {
				current_location++;
				if(current_location >= num_locations) {
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
						myLog.add("Changed location: " + data.latitude + "," + data.longitude + " (" + location_num + " / " + num_locations + ") " + label);

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
									myLog.standout(pokeAPI.pokemonlist[parseInt(cell.MapPokemon[j].PokedexTypeId) - 1].name + " is close enough to catch");
									if(pokemon_to_catch.indexOf(cell.MapPokemon[j]) < 0) {
										pokemon_to_catch.push(cell.MapPokemon[j]);
									}
								}
							}
							myLog.info(pokemon_to_catch.length + " catchable pokemon nearby");
							catchPokemon(pokemon_to_catch, function() {
								checkForts(forts, function(items) {
									showItems(items, items.length, function(ret) {
										if(ret != null && ret > 0) {
											showInventory(call_wait, function() {
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

function showItems(items, total, callback) {
	if(items.length) {
		var item = items.pop();
		var id = item.item_id;
		var info = getItemInfo(id);
		var name = info.name;
		var count = item.item_count;

		myLog.success("\tAcquired " + count + "x " + name);
		showItems(items, total, callback);
	} else {
		callback(total);
	}
}

function catchPokemon(pokemon_list, callback) {
	if(doCatch) {
		var pokemon = pokemon_list.pop();
		if(pokemon !== undefined) {
			//console.log(pokemon);
			getPokeballCounts(function(counts) {
				if(counts[0] > 0) {
					var pokedexInfo = pokeAPI.pokemonlist[parseInt(pokemon.PokedexTypeId) - 1];
					myLog.chat('There is a ' + pokedexInfo.name + ' near!! I can try to catch it!');

					pokeAPI.EncounterPokemon(pokemon, function(err, dat) {
						//console.log(err);
						//console.log(dat);
						if(err != "No result") {
							if(dat.WildPokemon !== undefined && dat.WildPokemon != null) {
								myLog.chat('Encountered pokemon ' + pokedexInfo.name + '...');
								getBallToUse(counts, function(pokeball_id) {
									if(pokeball_id != null) {
										pokeAPI.CatchPokemon(pokemon, 1, 1.950, 1, pokeball_id, function(xerr, xdat) {
											if(xerr != "No result") {
												var status = ['Unexpected error', 'Successful catch', 'Catch Escape', 'Catch Flee', 'Missed Catch'];
												var status_str;
												if(xdat !== undefined) {
													if(status[xdat.Status] !== undefined) {
														status_str = status[xdat.Status];
														if(xdat.Status == 1) {
															myLog.success(status_str);
														} else {
															myLog.warning(status_str);
														}
													}
													//console.log(xerr);
													//console.log(xdat);
												} else {
													myLog.warning("Unable to catch " + pokedexInfo.name + " (" + xdat + ")");
												}
											} else {
												myLog.warning("Unable to catch " + pokedexInfo.name + " (" + xerr + ")");
											}

											// any more items in array? continue loop
											if(pokemon_list.length > 0) {
												setTimeout(function() {
													catchPokemon(pokemon_list, callback);
												}, call_wait);
											} else {
												callback(true);
											}
										});
									} else {
										callback(true);
									}
								});
							} else {
								myLog.warning('Invalid value in WildPokemon when trying to encounter pokemon' + pokedexInfo.name + " (might be out of room...)");
								// any more items in array? continue loop
								if(pokemon_list.length > 0) {
									setTimeout(function() {
										catchPokemon(pokemon_list, callback);
									}, call_wait);
								} else {
									callback(true);
								}
							}
						} else {
							myLog.warning('Unable to encounter pokemon ' + pokedexInfo.name + " (" + err + ")");
							// any more items in array? continue loop
							if(pokemon_list.length > 0) {
								setTimeout(function() {
									catchPokemon(pokemon_list, callback);
								}, call_wait);
							} else {
								callback(true);
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

function getBallToUse(pokeball_counts, callback) {
	var i = 0;
	for(var ballIndex in pokeball_counts) {
		i++;
		if(ballIndex != 0) {
			if(pokeball_counts[ballIndex] != null && pokeball_counts[ballIndex] > 0) {
				callback(parseInt(ballIndex));
			}

			if(i > pokeball_counts.length) {
				callback(null);
			}
		}
	}
}

function showInventory(wait, callback) {
	// wait between tries
	setTimeout(function() {
		pokeAPI.GetInventory(function(err, data) {
			if(err) {
				myLog.error("From showInventory->pokeAPI.GetInventory:");
				myLog.error(err);
				myLog.error("Wait " + (retry_wait / 1000) + " seconds between retries");
				showInventory(retry_wait, callback);
			} else {
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
						myLog.info(itemCount + "x " + itemName + "s");
					}
				}
				myLog.info("######### " + total + " / " + item_storage + " items #########");
				callback(true);
			}
		});
	}, wait);
}

function showPokemon(wait, callback) {
	// wait between tries
	setTimeout(function() {
		pokeAPI.GetInventory(function(err, data) {
			if(err) {
				myLog.error("From showPokemon->pokeAPI.GetInventory:");
				myLog.error(err);
				myLog.error("Wait " + (retry_wait / 1000) + " seconds between retries");
				showPokemon(retry_wait, callback);
			} else {
				var total = 0;
				var pokemon_list = {};
				var scrap_exclude = [];
				for(var i in data.inventory_delta.inventory_items) {
					var entry = data.inventory_delta.inventory_items[i].inventory_item_data;
					if(entry.pokemon != null) {
						var pokemon = entry.pokemon;
						if(pokemon.is_egg == null) {
							total++;
							var pokemonId = pokemon.pokemon_id;
							if(pokemon_list[pokemonId] == undefined) {
								pokemon_list[pokemonId] = [];
							}
							var pokemonInfo = pokeAPI.pokemonlist[pokemonId - 1];
							pokemon.info = pokemonInfo;
							pokemon_list[pokemonId].push(pokemon);
							//console.log(pokemonInfo);
							if(pokemon.individual_attack == 15 && pokemon.individual_defense == 15 && pokemon.individual_stamina == 15) {
								myLog.success("############### PERFECT ###################");
								scrap_exclude.push(pokemon.id);
							}
							if(pokemon.favorite) {
								myLog.chat("############### FAVORITE ###################");
								scrap_exclude.push(pokemon.id);
							}
							myLog.info(pokemonInfo.name + "\tCP: " + pokemon.cp + "\tHP: " + pokemon.stamina + "/" + pokemon.stamina_max + "\tAT: " + pokemon.individual_attack + "\tDE: " + pokemon.individual_defense + "\tST: " + pokemon.individual_stamina);
							//console.log(pokeAPI.moveList[pokemon.move_1]);
							//console.log(pokeAPI.moveList[pokemon.move_2]);
							/*
							 cp: 125,
							 stamina: 26,
							 stamina_max: 26,
							 individual_attack: 13,
							 individual_defense: 12,
							 individual_stamina: 9,
							 */

							/*{ id: Long { low: -1246729654, high: 1755378363, unsigned: true },
							 pokemon_id: 78,
							 cp: 125,
							 stamina: 26,
							 stamina_max: 26,
							 move_1: 209,
							 move_2: 42,
							 deployed_fort_id: null,
							 owner_name: null,
							 is_egg: null,
							 egg_km_walked_target: null,
							 egg_km_walked_start: null,
							 origin: null,
							 height_m: 1.8355094194412231,
							 weight_kg: 94.11424255371094,
							 individual_attack: 13,
							 individual_defense: 12,
							 individual_stamina: 9,
							 cp_multiplier: 0.09399999678134918,
							 pokeball: 1,
							 captured_cell_id: Long { low: 0, high: -2024948480, unsigned: true },
							 battles_attacked: null,
							 battles_defended: null,
							 egg_incubator_id: null,
							 creation_time_ms: Long { low: -1549583149, high: 342, unsigned: true },
							 num_upgrades: 3,
							 additional_cp_multiplier: 0.09865091741085052,
							 favorite: null,
							 nickname: null,
							 from_fort: null }

							 { id: '78',
							 num: '078',
							 name: 'Rapidash',
							 img: 'http://www.serebii.net/pokemongo/pokemon/078.png',
							 type: 'Fire',
							 height: '1.70 m',
							 weight: '95.0 kg',
							 candy: 'None',
							 egg: 'Not in Eggs' }

							 */
						}
						/*

						 var itemName = itemInfo.name;
						 var itemCount = item.count;
						 if(itemCount != null && itemName != "Incubator (Unlimited)") {
						 total += itemCount;
						 }
						 myLog.info(itemCount + "x " + itemName + "s (" + itemID + ")");*/
					}
				}

				myLog.info("######### " + total + " / " + poke_storage + " pokemon #########");

				if(doScrap) {
					if(allow_scrap) {
						var pokemon_to_scrap = [];
						for(var i in pokemon_list) {
							//var pokemonInfo = pokeAPI.pokemonlist[i - 1];
							var numToKeep = 1;
							var numToScrap = pokemon_list[i].length - numToKeep;
							if(numToScrap > 0) {
								//myLog.info("\tSCRAPPING up to " + numToScrap + " " + pokemonInfo.name + "(s)");
								for(var j in pokemon_list[i]) {
									if(numToScrap > 0) {
										numToScrap--;
										pokemon = pokemon_list[i][j];
										if(scrap_exclude.indexOf(pokemon.id) < 0) {
											pokemon_to_scrap.push(pokemon);
										} else {
											//myLog.warning("\tNOT SCRAPPING (excluded): " + pokemon.info.name);
										}
									} else {
										//myLog.info("\tDONE SCRAPPING POKEMON: " + pokemon.info.name);
										break;
									}
								}
							} else {
								//myLog.warning("\tNOT SCRAPPING (not enough): " + numToKeep + " " + pokemonInfo.name + "(s)");
							}
						}
						if(pokemon_to_scrap.length > 0) {
							myLog.chat("Will try to scrap " + pokemon_to_scrap.length + " pokemon");
							transferPokemon(pokemon_to_scrap, function() {
								callback(true);
							});
						} else {
							callback(true);
						}
					} else {
						myLog.warning("\tNOT SCRAPPING: allow_scrap flag not set or false in user config");
						callback(true);
					}
				} else {
					callback(true);
				}
			}
		});
	}, wait);
}

function transferPokemon(pokemon_list, callback) {
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
}

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

function checkForts(fortCells, callback) {
	var options = {};

	options.cellsNearby = fortCells;
	getPokeStopsNearby(options, function(pokeStops) {
		var opts = {};
		opts.pokeStops = pokeStops;
		getPokeStops(opts, function(items) {
			callback(items);
		});
	});
}

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
		callback(options.items);
	}
}


/**
 *
 * @param options 		should contain cellsNearby and pokeStops arrays
 * @param callback
 */
function getPokeStopsNearby(options, callback) {
	var opts = {};
	if(options.pokeStops === undefined) {
		options.pokeStops = [];
	} else {
		opts.pokeStops = options.pokeStops;
	}
	if(options.cellsNearby.length > 0) {
		opts.forts = options.cellsNearby.pop();
		arePokeStopsNearby(opts, function(pokeStops) {
			options.pokeStops = pokeStops;
			getPokeStopsNearby(options, callback);
		});
	} else {
		callback(options.pokeStops);
	}
}

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
			if(distanceToFort < 0.0248548) {
				options.pokeStops.push(fort);
				//console.log(fortLocation.latitude + "," + fortLocation.longitude + " (" + fort.FortType + ") is CLOSE ENOUGH (" + distanceToFort + ")");
			} else {
				//console.log(fortLocation.latitude + "," + fortLocation.longitude + " (" + fort.FortType + ") is too far away (" + distanceToFort + ")");
			}
		}
		arePokeStopsNearby(options, callback);
	} else {
		callback(options.pokeStops);
	}
}

function getLocations(config_locations) {
	var locations = [];
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
			locations.push(location);
		}
	}
	return locations;
}

function tweakLocation(location) {
	var new_location = location;
	var lat_str = location.coords.latitude.toString();
	var lon_str = location.coords.longitude.toString();
	var lat_rand = Math.floor((Math.random() * 99) + 0).toString();
	var lon_rand = Math.floor((Math.random() * 99) + 0).toString();

	lat_str = lat_str.slice(0, -lat_rand.length) + lat_rand;
	lon_str = lon_str.slice(0, -lon_rand.length) + lon_rand;

	new_location.coords.latitude = parseFloat(lat_str);
	new_location.coords.longitude = parseFloat(lon_str);

	return new_location;
}

function toRad(num) {
	return num * Math.PI / 180;
}

function distance(point1, point2) {
	////////////////////////////////////////////////
	//Figure out how many miles between points
	////////////////////////////////////////////////
	var earthRadius = 6371; // radius of the earth in km
	var dLat = toRad(point2['latitude'] - point1['latitude']);
	var dLon = toRad(point2['longitude'] - point1['longitude']);
	var lat1 = toRad(point1['latitude']);
	var lat2 = toRad(point2['latitude']);

	var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.sin(dLon / 2) * Math.sin(dLon / 2) * Math.cos(lat1) * Math.cos(lat2);
	var angle = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
	var distanceBetweenPoints = earthRadius * angle;
	return distanceBetweenPoints / 0.621371; //convert to miles
}

function getItemInfo(id) {
	if(typeof id == "undefined") {
		return json;
	}

	for(var i in pokeAPI.itemlist) {
		if(pokeAPI.itemlist[i].id == id) {
			return pokeAPI.itemlist[i];
		}
	}
}
