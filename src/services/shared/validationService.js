// Validation Service - Reusable validation functions for all controllers
const { ValidationError } = require('../../lib/validationError');
const { normalizePhone } = require('../../lib/phoneNumber');

// ===================== VALIDATION HELPERS =====================

/**
 * Validates a required string field
 * @param {*} value - The value to validate
 * @param {string} fieldName - The name of the field for error messages
 * @throws {ValidationError} If validation fails
 */
function validateRequiredString(value, fieldName) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ValidationError(`${fieldName} wajib diisi`);
  }
  return value.trim();
}

/**
 * Validates an optional string field
 * @param {*} value - The value to validate
 * @param {string} fieldName - The name of the field for error messages
 * @returns {string|null} The trimmed string or null if not provided
 */
function validateOptionalString(value, fieldName) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  if (typeof value !== 'string') {
    throw new ValidationError(`${fieldName} harus berupa teks`);
  }
  return value.trim();
}

/**
 * Validates a positive integer
 * @param {*} value - The value to validate
 * @param {string} fieldName - The name of the field for error messages
 * @throws {ValidationError} If validation fails
 * @returns {number} The validated positive integer
 */
function validatePositiveInt(value, fieldName) {
  const num = Number(value);
  if (!Number.isInteger(num) || num <= 0) {
    throw new ValidationError(`${fieldName} harus berupa bilangan bulat positif`);
  }
  return num;
}

/**
 * Validates an optional positive integer
 * @param {*} value - The value to validate
 * @param {string} fieldName - The name of the field for error messages
 * @returns {number|null} The validated positive integer or null
 */
function validateOptionalPositiveInt(value, fieldName) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  return validatePositiveInt(value, fieldName);
}

/**
 * Validates a boolean field
 * @param {*} value - The value to validate
 * @param {string} fieldName - The name of the field for error messages
 * @returns {boolean} The validated boolean value
 */
function validateBoolean(value, fieldName) {
  if (typeof value === 'boolean') {
    return value;
  }
  if (value === 'true' || value === 1 || value === '1') {
    return true;
  }
  if (value === 'false' || value === 0 || value === '0') {
    return false;
  }
  throw new ValidationError(`${fieldName} harus berupa boolean (true/false)`);
}

/**
 * Validates an optional boolean field
 * @param {*} value - The value to validate
 * @param {string} fieldName - The name of the field for error messages
 * @returns {boolean|null} The validated boolean value or null
 */
function validateOptionalBoolean(value, fieldName) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  return validateBoolean(value, fieldName);
}

/**
 * Validates an email address
 * @param {*} value - The value to validate
 * @param {string} fieldName - The name of the field for error messages
 * @returns {string} The validated email address
 */
function validateEmail(value, fieldName = 'Email') {
  const email = validateOptionalString(value, fieldName);
  if (!email) {
    return null;
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    throw new ValidationError(`${fieldName} harus berupa alamat email yang valid`);
  }

  return email.toLowerCase();
}

/**
 * Validates a phone number (Indonesian format)
 * @param {*} value - The value to validate
 * @param {string} fieldName - The name of the field for error messages
 * @returns {string} The normalized phone number
 */
function validatePhone(value, fieldName = 'Nomor telepon') {
  const phoneNumber = normalizePhone(value);

  if (!phoneNumber || !phoneNumber.startsWith('8')) {
    throw new ValidationError(`${fieldName} harus diawali 8`);
  }

  return phoneNumber;
}

/**
 * Validates an array field
 * @param {*} value - The value to validate
 * @param {string} fieldName - The name of the field for error messages
 * @returns {Array} The validated array
 */
function validateArray(value, fieldName) {
  if (!Array.isArray(value)) {
    throw new ValidationError(`${fieldName} harus berupa array`);
  }
  return value;
}

/**
 * Validates an optional array field
 * @param {*} value - The value to validate
 * @param {string} fieldName - The name of the field for error messages
 * @returns {Array|null} The validated array or null
 */
function validateOptionalArray(value, fieldName) {
  if (value === null || value === undefined) {
    return null;
  }
  return validateArray(value, fieldName);
}

/**
 * Validates pagination parameters
 * @param {Object} params - The pagination parameters
 * @returns {Object} Validated pagination parameters
 */
function validatePagination(params = {}) {
  const defaultLimit = 20;
  const maxLimit = 100;

  const page = validateOptionalPositiveInt(params.page, 'Halaman') || 1;
  const limit = validateOptionalPositiveInt(params.limit, 'Limit') || defaultLimit;

  if (limit > maxLimit) {
    throw new ValidationError(`Limit tidak boleh melebihi ${maxLimit}`);
  }

  const offset = (page - 1) * limit;

  return { page, limit, offset };
}

// ===================== VALIDATION SCHEMAS =====================

/**
 * Customer registration validation schema
 * @param {Object} data - The registration data
 * @returns {Object} Validated registration data
 */
function validateCustomerRegistration(data) {
  const name = validateRequiredString(data?.name, 'Nama');
  const phone_number = validatePhone(data?.phone_number, 'Nomor telepon');
  const email = validateEmail(data?.email);

  return { name, phone_number, email };
}

/**
 * Login validation schema
 * @param {Object} data - The login data
 * @returns {Object} Validated login data
 */
function validateLogin(data) {
  const phone_number = validatePhone(data?.phone_number, 'Nomor telepon');
  const password = validateRequiredString(data?.password, 'Password');

  return { phone_number, password };
}

/**
 * Product filter validation schema
 * @param {Object} filters - The product filters
 * @returns {Object} Validated filters
 */
function validateProductFilters(filters = {}) {
  const validated = {};

  if (filters.category !== undefined) {
    validated.category = validateOptionalString(filters.category, 'Kategori');
  }

  if (filters.is_active !== undefined) {
    validated.is_active = validateOptionalBoolean(filters.is_active, 'Status aktif');
  }

  if (filters.search !== undefined) {
    validated.search = validateOptionalString(filters.search, 'Pencarian');
  }

  return validated;
}

/**
 * Location filter validation schema
 * @param {Object} filters - The location filters
 * @returns {Object} Validated filters
 */
function validateLocationFilters(filters = {}) {
  const validated = {};

  if (filters.is_outlet !== undefined) {
    validated.is_outlet = validateOptionalBoolean(filters.is_outlet, 'Status outlet');
  }

  if (filters.brand_id !== undefined) {
    validated.brand_id = validateOptionalPositiveInt(filters.brand_id, 'Brand ID');
  }

  return validated;
}

/**
 * Promo filter validation schema
 * @param {Object} filters - The promo filters
 * @returns {Object} Validated filters
 */
function validatePromoFilters(filters = {}) {
  const validated = {};

  if (filters.status !== undefined) {
    validated.status = validateOptionalString(filters.status, 'Status');
  }

  if (filters.is_visible !== undefined) {
    validated.is_visible = validateOptionalBoolean(filters.is_visible, 'Visibilitas');
  }

  return validated;
}

// ===================== EXPORTS =====================

module.exports = {
  // Basic validators
  validateRequiredString,
  validateOptionalString,
  validatePositiveInt,
  validateOptionalPositiveInt,
  validateBoolean,
  validateOptionalBoolean,
  validateEmail,
  validatePhone,
  validateArray,
  validateOptionalArray,
  validatePagination,

  // Validation schemas
  validateCustomerRegistration,
  validateLogin,
  validateProductFilters,
  validateLocationFilters,
  validatePromoFilters,
};