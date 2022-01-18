const mongoose = require('mongoose')

const MessageSchema = new mongoose.Schema({
  roomId: { type: mongoose.Schema.Types.ObjectId, ref: 'rooms' },
  senderId: { type: mongoose.Schema.Types.ObjectId, ref: 'users' },
  text: String,
  deliveredTo: [{ user: { type: mongoose.Schema.Types.ObjectId, ref: 'users' }, timestamp: Date }],
  readBy: [{ user: { type: mongoose.Schema.Types.ObjectId, ref: 'users' }, timestamp: Date }],
})

MessageSchema.pre(['find', 'save', 'findOne'], function () {
  this.populate('senderId')
})

module.exports = mongoose.model('messages', MessageSchema)
