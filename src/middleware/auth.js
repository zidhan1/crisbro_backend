const jwt = require('jsonwebtoken');
const getJwtSecret = require('../lib/jwtSecret');

module.exports = (req, res, next) => {
  const header = req.headers.authorization;

  if (!header) {
    return res.status(401).json({
      message: 'Unauthorized',
    });
  }

  const token = header.split(' ')[1];

  if (!token) {
    return res.status(401).json({
      message: 'Unauthorized',
    });
  }

  try {
    const decoded = jwt.verify(token, getJwtSecret());

    req.user = decoded;
  } catch (error) {
    if (error.code === 'JWT_SECRET_MISSING') {
      return res.status(500).json({
        message: 'Authentication configuration error',
      });
    }

    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        message: 'Token expired',
      });
    }

    return res.status(401).json({
      message: 'Invalid or expired token',
    });
  }

  next();
};
