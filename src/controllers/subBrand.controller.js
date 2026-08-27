const { successRequest } = require("../utils/responseReuest");
const {
  generateSubBrandsRunchise,
  listSubBrandsService,
} = require("../services/subBrand.service");

async function generateSubBrand(req, res) {
  const response = await generateSubBrandsRunchise();

  return successRequest({
    res,
    code: response.code,
    data: response.data,
    message: response.message,
  });
}

async function listSubBrands(req, res) {
  const subBrands = await listSubBrandsService();

  return successRequest({
    res,
    code: 200,
    data: subBrands,
    message: "Sub brands retrieved successfully.",
  });
}

module.exports = { generateSubBrand, listSubBrands };
