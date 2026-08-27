// Customer Service - Customer operations business logic
const prisma = require('../../lib/prisma');

// ===================== CUSTOMER QUERIES =====================

/**
 * Get customer points by user ID
 * @param {number} userId - The user ID
 * @returns {Promise<Object>} Customer points data
 */
async function getCustomerPointsByUserId(userId) {
  const customer = await prisma.customer.findUnique({
    where: { user_id: userId },
    include: { customer_point: true },
  });

  if (!customer) {
    throw new Error('Customer tidak ditemukan');
  }

  // Return customer point data or default empty points
  return customer.customer_point ?? {
    available_point: 0,
    total_point: 0,
  };
}

/**
 * Get customer by user ID with full data
 * @param {number} userId - The user ID
 * @returns {Promise<Object>} Customer data
 */
async function getCustomerByUserId(userId) {
  const customer = await prisma.customer.findUnique({
    where: { user_id: userId },
    include: {
      customer_point: true,
      user: {
        select: {
          id: true,
          email: true,
          phone_number: true,
          role: true,
        },
      },
    },
  });

  return customer;
}

/**
 * Get customer by customer ID
 * @param {number} customerId - The customer ID
 * @returns {Promise<Object>} Customer data
 */
async function getCustomerById(customerId) {
  const customer = await prisma.customer.findUnique({
    where: { id: Number(customerId) },
    include: {
      customer_point: true,
      user: {
        select: {
          id: true,
          email: true,
          phone_number: true,
          role: true,
        },
      },
    },
  });

  return customer;
}

// ===================== CUSTOMER TRANSFORMATION =====================

/**
 * Transform database customer to API response format
 * @param {Object} customer - The customer from database
 * @returns {Object} Formatted customer for API response
 */
function formatCustomerForAPI(customer) {
  if (!customer) return null;

  return {
    id: customer.id,
    user_id: customer.user_id,
    phone_number: customer.phone_number,
    name: customer.name,
    customer_point: customer.customer_point || {
      available_point: 0,
      total_point: 0,
    },
  };
}

/**
 * Transform customer with points summary
 * @param {Object} customer - The customer from database
 * @returns {Object} Formatted customer points summary
 */
function formatCustomerPointsSummary(customer) {
  if (!customer) {
    return {
      available_point: 0,
      total_point: 0,
    };
  }

  return customer.customer_point || {
    available_point: 0,
    total_point: 0,
  };
}

// ===================== EXPORTS =====================

module.exports = {
  // Customer queries
  getCustomerPointsByUserId,
  getCustomerByUserId,
  getCustomerById,

  // Customer transformation
  formatCustomerForAPI,
  formatCustomerPointsSummary,
};