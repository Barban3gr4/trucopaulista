const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server);
const path = require('path');

app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Estado Global
const rooms = {};
let nextRoomId = 1;

function broadcastRoomList() {
    const list = [];
    for(const id in rooms) {
        list.push({
            id: id,
            name: rooms[id].name, // Nome amigável "Sala 1"
            count: rooms[id].playerCount, // Apenas sentados
            full: rooms[id].playerCount >= 4
        });
    }
    io.emit('room_list_update', list);
}

io.on('connection', (socket) => {
    // Envia lista inicial
    broadcastRoomList();

    socket.on('create_room', ({ playerName }) => {
        // Limite de 10 salas
        if (Object.keys(rooms).length >= 10) {
            socket.emit('room_error', 'Limite de salas atingido (Máx 10). Aguarde uma sala esvaziar.');
            return;
        }

        // Buscar menor ID disponível (1..10)
        let roomNum = 1;
        while (true) {
            const potentialId = `room_${roomNum}`;
            if (!rooms[potentialId]) {
                break; // Achou livre
            }
            roomNum++;
        }
        
        const roomId = `room_${roomNum}`;
        const roomName = `Sala ${roomNum}`;
        
        rooms[roomId] = {
            id: roomId,
            name: roomName,
            players: { 0: null, 1: null, 2: null, 3: null }, // Slots fixos
            playerCount: 0, // Sentados
            clients: [], // Todos conectados na sala (incluindo em pé)
            gameStarted: false
        };
        
        // Auto-entrar
        socket.emit('room_created', { roomId });
        broadcastRoomList();
    });

    socket.on('join_room', ({ roomId, playerName, avatarId }) => {
        const room = rooms[roomId];
        if (!room) {
            socket.emit('room_error', 'Sala não encontrada.');
            return;
        }

        socket.join(roomId);
        
        // Adiciona à lista de clientes (espectadores/lobby)
        const clientObj = { id: socket.id, name: playerName, avatarId, slot: -1 };
        room.clients.push(clientObj);

        // Envia estado atual da sala para quem entrou
        socket.emit('room_state', {
            roomId: room.id,
            roomName: room.name,
            players: room.players,
            mySessionId: socket.id
        });
        
        console.log(`User ${playerName} entrou no lobby da sala ${room.name}`);
    });

    socket.on('sit_down', ({ roomId, slot }) => {
        const room = rooms[roomId];
        if (!room) return;
        
        // Validar slot
        if (room.players[slot] !== null) {
            socket.emit('sit_error', 'Lugar ocupado!');
            return;
        }

        // Buscar dados do cliente
        const client = room.clients.find(c => c.id === socket.id);
        if(!client) return;

        // Se já estiver sentado em outro lugar, levantar primeiro
        if(client.slot !== -1) {
            room.players[client.slot] = null;
            room.playerCount--;
        }

        // Sentar
        client.slot = slot;
        room.players[slot] = client;
        room.playerCount++;

        // Notificar sala
        io.to(roomId).emit('update_players', room.players);
        broadcastRoomList();
    });

    socket.on('leave_seat', ({ roomId }) => {
        const room = rooms[roomId];
        if(!room) return;
        
        const client = room.clients.find(c => c.id === socket.id);
        if(client && client.slot !== -1) {
            room.players[client.slot] = null;
            room.playerCount--;
            client.slot = -1;
            io.to(roomId).emit('update_players', room.players);
            broadcastRoomList();
            
            // Se jogo estava rolando? Cancelar? Por enquanto, permitir sair.
            if(room.gameStarted) {
                io.to(roomId).emit('player_disco', { slot: client.slot, name: client.name });
            }
        }
    });

    // Novo: Iniciar Jogo apenas pelo Host (quem está no slot 0, ou qualquer um? Geralmente Host)
    // Vamos assumir que Slot 0 é o "Host" da mesa lógica, ou qualquer um pode iniciar se estiver cheio.
    // O pedido diz "botão de iniciar partida quando todos estiverem na sala"
    socket.on('request_start_game', ({ roomId }) => {
        const room = rooms[roomId];
        // Validar se tem 4 jogadores sentados (ou 2 para 1v1? Truco é 4)
        if(room && room.playerCount === 4) {
             room.gameStarted = true;
             // Distribuir cartas etc (lógica movida para cá ou mantida no frontend via comando?)
             // Mantendo lógica de "pass-through" mas com disparo oficial
             io.to(roomId).emit('remote_game_start');
        }
    });

    // Eventos de pass-through (Mantendo compatibilidade com lógica existente por enquanto)
    socket.on('distribuir_cartas', (data) => socket.to(data.roomId).emit('distribuir_cartas', data)); // Host envia
    socket.on('jogar_carta', (data) => {
        // Precisamos saber a sala. Adicionar roomId no payload do cliente
        const room = getRoomBySocket(socket);
        if(room) socket.to(room.id).emit('remote_jogar_carta', data);
    });
    
    // ... outros eventos similares ...
    socket.on('truco_action', (data) => {
         const room = getRoomBySocket(socket);
         if(room) socket.to(room.id).emit('remote_truco_action', data);
    });

    socket.on('disconnect', () => {
        // Encontrar sala
        for(const id in rooms) {
            const room = rooms[id];
            const clientIdx = room.clients.findIndex(c => c.id === socket.id);
            if(clientIdx !== -1) {
                const client = room.clients[clientIdx];
                // Remover do slot se estiver sentado
                if(client.slot !== -1) {
                    room.players[client.slot] = null;
                    room.playerCount--;
                    io.to(id).emit('update_players', room.players);
                    
                    if(room.gameStarted) {
                        io.to(id).emit('player_disco', { slot: client.slot, name: client.name });
                    }
                }
                
                // Remover da lista de clientes
                room.clients.splice(clientIdx, 1);
                
                // Se sala vazia, deletar
                if(room.clients.length === 0) {
                    delete rooms[id];
                }
                broadcastRoomList();
                break;
            }
        }
    });
});

function getRoomBySocket(socket) {
    for(const id in rooms) {
        if(rooms[id].clients.find(c => c.id === socket.id)) return rooms[id];
    }
    return null;
}

const PORT = 3005;
server.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
