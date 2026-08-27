const { successRequest } = require("../utils/responseReuest");
const {
  generateLocationService,
  listLocationsService,
} = require("../services/location.service");

async function generateLocations(req, res) {
  const result = await generateLocationService();

  return successRequest({
    res,
    code: result.code,
    data: result.data,
    message: result.message,
  });
}

async function listLocations(req, res) {
  const locations = await listLocationsService();

  return successRequest({
    res,
    code: 200,
    data: locations,
    message: "Locations retrieved successfully.",
  });
}

module.exports = { generateLocations, listLocations };
