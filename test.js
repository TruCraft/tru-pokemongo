#! /usr/bin/env node

'use strict';

const commandLineArgs = require('command-line-args');
const getUsage = require('command-line-usage');
//var LatLon = require('geodesy').LatLonEllipsoidal;
const LatLon = require('geodesy').LatLonSpherical;

const optionDefinitions = [
	{
		header: 'Test script',
		content: 'Script used to test new things'
	},
	{
		header: 'Options',
		optionList: [
			{
				name: 'username',
				alias: 'u',
				type: String,
				defaultOption: true,
				typeLabel: '[underline]{username}',
				description: 'User account (matches against a filename in the ./configs/ directory)'
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

var username = flags.username;

if(username == null) {
	showUsage("You must provide a username (-u)");
}

var fs = require('fs');

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

var fortsdata = fs.readFileSync(__dirname + "/testStops.json", 'utf8');
var fortsjson = JSON.parse(fortsdata);

fortsjson.unsorted.sort(dynamicSortMultiple("Latitude", "Longitude"));

getCoordsFromJSON(fortsjson.unsorted);

function getCoordsFromJSON(json) {
	console.log("lat,lon,name");
	for(var i in json) {
		var loc = json[i];
		console.log(loc.Latitude + "," + loc.Longitude + "," + i);
	}
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

process.exit();

var current_location = 0;
var config_locations = getLocations(account_config.locations);
var locations = [];
var first_location = config_locations[current_location];

var max_dist = 40;

main();

/**
 * Main process
 */
function main() {
	getPath(null, first_location, function() {
		console.log("DONE");
	});
}

function getPath(last_location, first_location, callback) {
	if(config_locations.length > 0) {
		var location = config_locations.shift();
		var point = new LatLon(location.coords.latitude, location.coords.longitude);
		if(last_location == null) {
			addToLocations(point, "Poke Stop");
			getPath(location, first_location, callback);
		} else {
			var dist = distance(last_location.coords, location.coords);
			if(dist > max_dist) {
				//console.log("Too far between points - need to add points between (" + dist + ")");
				getIntermediatePoints({
					point1: last_location.coords,
					point2: location.coords,
					percent: (max_dist / dist)
				}, function() {
					addToLocations(point, "Poke Stop");
				});
			}
			getPath(location, first_location, callback);
		}
	} else {
		var dist = distance(last_location.coords, first_location.coords);
		if(dist > max_dist) {
			getIntermediatePoints({
				point1: last_location.coords,
				point2: first_location.coords,
				percent: (max_dist / dist)
			}, function() {
				// do nothing
			});
		}
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
			if(distanceToFort < 0.0248548) {
				options.pokeStops.push(fort);
				console.log(fortLocation.latitude + "," + fortLocation.longitude + " (" + fort.FortType + ") is CLOSE ENOUGH (" + distanceToFort + ")");
			} else {
				console.log(fortLocation.latitude + "," + fortLocation.longitude + " (" + fort.FortType + ") is too far away (" + distanceToFort + ")");
			}
		}
		arePokeStopsNearby(options, callback);
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
	var lat_rand = Math.floor((Math.random() * 99) + 0).toString();
	var lon_rand = Math.floor((Math.random() * 99) + 0).toString();

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

function addToLocations(latlon, label) {
	console.log(latlon.lat + "," + latlon.lon);
	var location = {
		"type": "coords",
		"coords": {
			"latitude": latlon.lat,
			"longitude": latlon.lon
		}
	};
	if(label !== undefined && label != null) {
		location.label = label;
	}
	locations.push(location);
}