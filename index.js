const express = require('express')
require('dotenv').config()
const { createServer } = require('http')
const moment = require('moment')
const app = express()
const Mongo = require('mongodb').MongoClient
const mongoose = require('mongoose')
const ObjectId = mongoose.Types.ObjectId
const { Server } = require('socket.io')
const httpServer = createServer(app)
const socketClient = new Server(httpServer)
const Room = require('./Room')
const Message = require('./Message')
const User = require('./User')
const uri = process.env.MONGODB_URI
Mongo.connect(uri, (err, client) => {
  if (!client) return
  mongoose.connect(uri)
  socketClient.on('connection', socket => {
    async function getStatus(msg, roomId) {
      const numOfMembers = await Room.findById(roomId).then(r => r.members.length)
      let status = 'sent'
      if (numOfMembers <= 2) {
        if (msg?.readBy?.length === numOfMembers - 1)
          status = `read ${moment(msg.readBy[msg.readBy.length - 1].timestamp).fromNow()}`
        else if (msg?.deliveredTo?.length === numOfMembers - 1)
          status = `delivered ${moment(
            msg.deliveredTo[msg.deliveredTo.length - 1].timestamp
          ).fromNow()}`
      } else {
        if (msg?.readBy?.length) status = `read by ${msg.readBy.map(u => u.user.name).join(', ')}`
        else if (msg?.deliveredTo?.length)
          status = `delivered to ${msg.deliveredTo.map(u => u.user.name).join(', ')}`
      }
      return status
    }

    async function getMessages(room, user) {
      Message.find({ roomId: room })
        .populate('deliveredTo.user readBy.user')
        .then(messages => {
          const promises = []
          const msgs = messages.map(msg => {
            let status = getStatus(msg, room)
            promises.push(status)
            return { msg, status: status }
          })
          Promise.all(promises).then(p => {
            for (key in msgs) {
              msgs[key].status = p[key]
            }
            socket.emit('messages', msgs)
          })
          Message.updateMany(
            { roomId: room, senderId: { $ne: user }, 'readBy.user': { $ne: user } },
            { $push: { readBy: { user: user, timestamp: new Date() } } }
          ).catch(err => console.log(err))
        })
    }

    User.find().then(users => socket.emit('users', users))
    socket.on('login', user => {
      User.findByIdAndUpdate(user.id, { online: true, isActive: true }).then(_u => {
        Room.find({ members: _u._id }).then(rooms => {
          socket.emit('rooms', rooms)
          rooms.forEach(room => {
            Message.updateMany(
              { roomId: room._id, senderId: { $ne: _u._id }, 'deliveredTo.user': { $ne: _u._id } },
              { $push: { deliveredTo: { user: _u._id, timestamp: new Date() } } }
            ).catch(err => console.log(err))
          })
        })
      })

      socket.on('get messages', room => {
        getMessages(room.id, room.user)
        const pipeline = [{ $match: { 'fullDocument.roomId': ObjectId(room.id) } }]
        const collection = client.db('chat').collection('messages')
        const messageStream = collection.watch(pipeline, { fullDocument: 'updateLookup' })
        messageStream.on('change', async function (change) {
          const updates = change.updateDescription?.updatedFields
          if (change.operationType.match(/insert/i)) {
            const doc = await Message.findById(change.fullDocument._id).populate(
              'deliveredTo.user readBy.user'
            )
            const status = await getStatus(doc, room.id)
            socket.emit('push message', { doc, status: status })
          } else if (updates?.deliveredTo) {
            const status = await getStatus(change.fullDocument, room.id)
            socket.emit('status change', {
              id: change.fullDocument._id,
              status: status,
            })
          } else if (updates?.readBy) {
            const status = await getStatus(change.fullDocument, room.id)
            socket.emit('status change', {
              id: change.fullDocument._id,
              status: status,
            })
          }
        })
      })
    })

    socket.on('new message', async _ => {
      const ids = await Room.findById(_.room).then(_res =>
        _res.members.filter(e => e.toString() != _.user.id)
      )
      const usersDocs = await User.find({ _id: { $in: ids }, online: true })
      const deliveredTo = usersDocs.map(user => {
        return { user: user._id, timestamp: new Date() }
      })
      const readBy = usersDocs.reduce((acc, user) => {
        if (user.isActive) acc.push({ user: user._id, timestamp: new Date() })
        return acc
      }, [])
      await new Message({
        roomId: _.room,
        senderId: _.user.id,
        text: _.text,
        deliveredTo: deliveredTo,
        readBy: readBy,
      }).save()
    })

    socket.on('logout', user => {
      if (!user) return
      User.findByIdAndUpdate(user, { online: false, isActive: false }).then(() => console.log())
    })

    socket.on('set user inactive', user => {
      if (!user) return
      User.findByIdAndUpdate(user, { isActive: false }).then(() => console.log())
    })

    socket.on('set user active', ({ user, room }) => {
      if (!user) return
      User.findByIdAndUpdate(user, { isActive: true }).then(() => console.log())
      Message.updateMany(
        { roomId: room, senderId: { $ne: user }, 'readBy.user': { $ne: user } },
        { $push: { readBy: { user: user, timestamp: new Date() } } }
      ).catch(err => console.log(err))
    })
  })
})

app.use(express.static(__dirname + '/pages'))

//if (process.env.NODE_ENV == 'development') {
httpServer.listen(process.env.PORT, () => {
  console.log(`Example app listening at http://localhost:${process.env.PORT}`)
})
//}
