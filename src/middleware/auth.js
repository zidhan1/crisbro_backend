const jwt = require('jsonwebtoken');

module.exports = (req, res, next) => {
  const header = req.headers.authorization;

  if (!header) {
    return res.status(401).json({
      message: 'Unauthorized',
    });
  }

  const token = header.split(' ')[1];

  const decoded = jwt.verify(token, process.env.JWT_SECRET || 'SECRET_KEY');
  
  req.user = decoded;

  next();
};
