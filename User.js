const mongoose = require('mongoose')

const UserSchema = new mongoose.Schema({
  name: String,
  online: Boolean,
  isActive: Boolean,
})
module.exports = mongoose.model('users', UserSchema)
