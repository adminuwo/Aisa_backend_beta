import { Server } from 'socket.io';

let io;

export const initSocket = (server) => {
    io = new Server(server, {
        cors: {
            origin: "*",
            methods: ["GET", "POST"]
        }
    });

    io.on('connection', (socket) => {
        console.log(`[Socket] Client connected: ${socket.id}`);

        socket.on('join', async (userId) => {
            socket.join(userId.toString());
            console.log(`[Socket] User ${userId} joined room`);
            
            // Optional: Send a login alert
            io.to(userId.toString()).emit('new_notification', {
                id: `login_${Date.now()}`,
                title: 'Connected to AISA™',
                desc: 'Real-time synchronization established.',
                type: 'success',
                time: new Date(),
                isRead: false
            });
        });


        socket.on('disconnect', () => {
            console.log(`[Socket] Client disconnected: ${socket.id}`);
        });
    });

    return io;
};

export const getIO = () => {
    if (!io) {
        throw new Error('Socket.io not initialized!');
    }
    return io;
};

export const notifyUser = (userId, notification) => {
    if (io) {
        io.to(userId.toString()).emit('new_notification', notification);
    }
};
