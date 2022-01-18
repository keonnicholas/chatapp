const mongoose = require('mongoose')

const RoomSchema = new mongoose.Schema({
  name: String,
  members: [{ type: mongoose.Schema.Types.ObjectId, ref: 'users' }],
})
module.exports = mongoose.model('rooms', RoomSchema)
