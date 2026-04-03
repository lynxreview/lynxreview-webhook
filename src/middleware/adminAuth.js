const jwt = require('jsonwebtoken');
const Admin = require('../models/Admin');

const adminAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'No token provided' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    if (decoded.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Admin access required' });
    }

    const admin = await Admin.findById(decoded.userId);
    if (!admin) {
      return res.status(401).json({ success: false, error: 'Admin not found' });
    }

    req.adminId = decoded.userId;
    req.adminEmail = admin.email;
    next();
  } catch (error) {
    return res.status(401).json({ success: false, error: 'Invalid admin token' });
  }
};

module.exports = adminAuth;
