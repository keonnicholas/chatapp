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
  if (err) console.log(err)
  if (!client) return
  mongoose.connect(uri)

  socketClient.on('connection', socket => {
    //
    //on load all users for login select
    User.find().then(users => socket.emit('users', users))

    //
    //takes a message and room id and format the status to be read on client
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

    //
    //queries all messeages based on room;
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
            //
            //returns all messages to the client
            socket.emit('messages', msgs)
          })

          //
          //mark all messages as read, that do not belong to current user and user has not already read
          Message.updateMany(
            { roomId: room, senderId: { $ne: user }, 'readBy.user': { $ne: user } },
            { $push: { readBy: { user: user, timestamp: new Date() } } }
          ).catch(err => console.log(err))
        })
    }

    //
    //On login, change user status to online and active
    //then find all rooms user is a member of
    //return rooms to client
    //then update all messages as delivered, that do not belong to current user and has not already been delivered to user
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

      //Calls function to get all messages for client

      socket.on('get messages', room => {
        getMessages(room.id, room.user)

        //
        //setting pipeline for readStream to only watch for changes in the messages collection
        //where the roomId field is the current room the user has loaded
        //setting fulldocument : 'updateLookup' option will always return the fulldocuemnt with any updates
        //without this, the fulldocument will only be returned on our insert change
        const pipeline = [{ $match: { 'fullDocument.roomId': ObjectId(room.id) } }]
        const collection = client.db('chat').collection('messages')
        const messageStream = collection.watch(pipeline, { fullDocument: 'updateLookup' })
        messageStream.on('change', async function (change) {
          const updates = change.updateDescription?.updatedFields
          //
          //if a new document is created in messages, then push that message to the client
          if (change.operationType.match(/insert/i)) {
            const doc = await Message.findById(change.fullDocument._id).populate(
              'deliveredTo.user readBy.user'
            )
            const status = await getStatus(doc, room.id)
            socket.emit('push message', { doc, status: status })
            //
            //if delivered to has been updated on a message then send to client
          } else if (updates?.deliveredTo) {
            const status = await getStatus(change.fullDocument, room.id)
            socket.emit('status change', {
              id: change.fullDocument._id,
              status: status,
              user: change.fullDocument.senderId,
            })
            //
            //if readby has been updated on a message then send to client
          } else if (updates?.readBy) {
            const status = await getStatus(change.fullDocument, room.id)
            socket.emit('status change', {
              id: change.fullDocument._id,
              status: status,
              user: change.fullDocument.senderId,
            })
          }
        })
      })
    })

    //
    //On a new message, see who is online -- make those messages as delived to those currently online
    // see who is active -- mark those messsages as read to those currently active
    socket.on('new message', async _ => {
      //get the ids of all the users for the current room, excluding the current user
      const ids = await Room.findById(_.room).then(_res =>
        _res.members.filter(e => e.toString() != _.user.id)
      )
      //get all the user docs for those ids that are online
      const usersDocs = await User.find({ _id: { $in: ids }, online: true })
      //set delivered to those online
      const deliveredTo = usersDocs.map(user => {
        return { user: user._id, timestamp: new Date() }
      })
      //if user is also active then set read by
      const readBy = usersDocs.reduce((acc, user) => {
        if (user.isActive) acc.push({ user: user._id, timestamp: new Date() })
        return acc
      }, [])
      //create new message
      await new Message({
        roomId: _.room,
        senderId: _.user.id,
        text: _.text,
        deliveredTo: deliveredTo,
        readBy: readBy,
      }).save()
    })

    //log out user by changing online and active to false
    socket.on('logout', user => {
      if (!user) return
      User.findByIdAndUpdate(user, { online: false, isActive: false }).then(() => console.log())
    })

    //on client window blur show user as inactive
    socket.on('set user inactive', user => {
      if (!user) return
      User.findByIdAndUpdate(user, { isActive: false }).then(() => console.log())
    })
    //on focus change user as active and update all messages that has not been read bu user to read
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

httpServer.listen(process.env.PORT, () => {
  console.log(`Example app listening at ${process.env.PORT}`)
})
