const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');
const socketIo = require('socket.io');
const webpush = require('web-push');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');

const vapidKeys = {
    publicKey: 'BG_mvqULlWO1eUaikilybUP9aRMlUQONojEX4b1AlYnpzkI60W2KcGdXei8Et2JsBB6rh8C_sleTLXpQT3EgiO0',
    privateKey: 'sMfgQaMQTQwV17ZleZUfJX0hpfa_HcPZ3Q8ZVewHp0w'
};

webpush.setVapidDetails(
    'mailto:your-email@example.com',
    vapidKeys.publicKey,
    vapidKeys.privateKey
);

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, './')));

let subscriptions = [];
const reminders = new Map();

const HTTPS_PORT = Number(process.env.HTTPS_PORT || process.env.PORT || 3006);
const HTTP_PORT = Number(process.env.HTTP_PORT || 3005);
const MAX_PORT_TRIES = Number(process.env.PORT_TRIES || 10);

let actualHttpsPort = HTTPS_PORT;
let actualHttpPort = HTTP_PORT;
let isHttpsServer = true;

const httpApp = express();
httpApp.use((req, res) => {
    const host = req.headers.host || 'localhost';
    const hostname = host.split(':')[0];
    const portPart = actualHttpsPort === 443 ? '' : `:${actualHttpsPort}`;
    res.redirect(`https://${hostname}${portPart}${req.url}`);
});

function listenWithRetries(serverInstance, startPort, maxTries, label, onListening) {
    const tryListen = (port, attempt) => {
        serverInstance.once('error', (err) => {
            if (err.code === 'EADDRINUSE' && attempt < maxTries) {
                tryListen(port + 1, attempt + 1);
                return;
            }
            console.error(`${label} не запущен:`, err.message);
            process.exit(1);
        });
        serverInstance.listen(port, () => onListening(port));
    };
    tryListen(startPort, 0);
}

let server;
try {
    const options = {
        key: fs.readFileSync('./localhost+2-key.pem'),
        cert: fs.readFileSync('./localhost+2.pem')
    };
    server = https.createServer(options, app);
    console.log('HTTPS сервер инициализирован');
} catch (err) {
    console.log('Сертификаты не найдены, запускаем HTTP сервер');
    server = http.createServer(app);
    isHttpsServer = false;
}

const io = socketIo(server, {
    cors: {
        origin: (origin, callback) => {
            if (!origin || /^https?:\/\/localhost(:\d+)?$/.test(origin)) {
                callback(null, true);
                return;
            }
            callback(new Error('Not allowed by CORS'));
        },
        methods: ["GET", "POST"],
        credentials: true
    },
    allowEIO3: true
});

io.on('connection', (socket) => {
    console.log('Клиент подключён:', socket.id);

    socket.on('newNote', (note) => {
        console.log('Получена новая заметка:', note.text);
        io.emit('noteAdded', note);

        const payload = JSON.stringify({
            title: 'Новая заметка',
            body: note.text
        });

        const invalidSubscriptions = [];
        subscriptions.forEach((sub, index) => {
            webpush.sendNotification(sub, payload).catch(err => {
                console.error(`Ошибка отправки push подписчику ${index}:`, err.statusCode);
                if (err.statusCode === 410 || err.statusCode === 404) {
                    invalidSubscriptions.push(sub);
                }
            });
        });

        if (invalidSubscriptions.length > 0) {
            subscriptions = subscriptions.filter(sub => !invalidSubscriptions.includes(sub));
            console.log(`Удалено ${invalidSubscriptions.length} невалидных подписок, осталось: ${subscriptions.length}`);
        }
    });

    socket.on('newReminder', (reminder) => {
        const { id, text, reminderTime } = reminder;
        const delay = reminderTime - Date.now();

        console.log(`Получено напоминание: "${text}" на ${new Date(reminderTime).toLocaleString()}`);
        console.log(`Текущее время: ${new Date().toLocaleString()}`);
        console.log(`Задержка: ${delay}ms (${(delay / 1000 / 60).toFixed(2)} минут)`);

        if (delay <= 0) {
            console.log('Время уже прошло, напоминание не запланировано');
            return;
        }

        const timeoutId = setTimeout(() => {
            console.log(`ОТПРАВКА УВЕДОМЛЕНИЯ: "${text}"`);
            const payload = JSON.stringify({
                title: '!!! Напоминание',
                body: text,
                reminderId: id
            });

            console.log(`Количество подписчиков: ${subscriptions.length}`);

            const invalidSubscriptions = [];
            subscriptions.forEach((sub, index) => {
                console.log(`Отправка подписчику ${index + 1}`);
                webpush.sendNotification(sub, payload).catch(err => {
                    console.error(`Ошибка отправки подписчику ${index}:`, err.statusCode);
                    if (err.statusCode === 410 || err.statusCode === 404) {
                        invalidSubscriptions.push(sub);
                    }
                });
            });

            if (invalidSubscriptions.length > 0) {
                subscriptions = subscriptions.filter(sub => !invalidSubscriptions.includes(sub));
                console.log(`Удалено ${invalidSubscriptions.length} невалидных подписок, осталось: ${subscriptions.length}`);
            }

            console.log(`Напоминание отправлено, ID: ${id} (оставлено для откладывания)`);
        }, delay);

        reminders.set(id, { timeoutId, text, reminderTime });
        console.log(`Таймер установлен, ID: ${id}`);
    });

    socket.on('disconnect', () => {
        console.log('Клиент отключён:', socket.id);
    });
});

app.post('/subscribe', (req, res) => {
    const subscription = req.body;
    console.log('Получена подписка:', subscription.endpoint);

    const exists = subscriptions.some(sub => sub.endpoint === subscription.endpoint);
    if (!exists) {
        subscriptions.push(subscription);
    }

    console.log('Всего подписок:', subscriptions.length);
    res.status(201).json({ message: 'Подписка сохранена' });
});

app.post('/unsubscribe', (req, res) => {
    const { endpoint } = req.body;
    subscriptions = subscriptions.filter(sub => sub.endpoint !== endpoint);
    console.log('Отписка, осталось:', subscriptions.length);
    res.status(200).json({ message: 'Подписка удалена' });
});

app.post('/snooze', (req, res) => {
    const reminderId = parseInt(req.query.reminderId, 10);
    console.log('Запрос на откладывание, ID:', reminderId);
    console.log('Активные reminders:', Array.from(reminders.keys()));

    if (!reminderId || !reminders.has(reminderId)) {
        console.log('Напоминание не найдено');
        return res.status(400).json({ error: 'Reminder not found' });
    }

    const reminder = reminders.get(reminderId);
    clearTimeout(reminder.timeoutId);

    const newDelay = 5 * 60 * 1000;
    const newTimeoutId = setTimeout(() => {
        console.log(`ОТПРАВКА ОТЛОЖЕННОГО УВЕДОМЛЕНИЯ: "${reminder.text}"`);
        const payload = JSON.stringify({
            title: 'Напоминание (отложено)',
            body: reminder.text,
            reminderId: reminderId
        });

        const invalidSubscriptions = [];
        subscriptions.forEach((sub) => {
            webpush.sendNotification(sub, payload).catch(err => {
                console.error('Ошибка отправки отложенного push:', err.statusCode);
                if (err.statusCode === 410 || err.statusCode === 404) {
                    invalidSubscriptions.push(sub);
                }
            });
        });

        if (invalidSubscriptions.length > 0) {
            subscriptions = subscriptions.filter(sub => !invalidSubscriptions.includes(sub));
            console.log(`Удалено ${invalidSubscriptions.length} невалидных подписок`);
        }

        reminders.delete(reminderId);
    }, newDelay);

    reminders.set(reminderId, {
        timeoutId: newTimeoutId,
        text: reminder.text,
        reminderTime: Date.now() + newDelay
    });

    console.log(`Напоминание ID ${reminderId} отложено на 5 минут`);
    res.status(200).json({ message: 'Reminder snoozed for 5 minutes' });
});


listenWithRetries(server, HTTPS_PORT, MAX_PORT_TRIES, 'Основной сервер', (port) => {
    actualHttpsPort = port;
    const protocol = isHttpsServer ? 'https' : 'http';
    console.log(`Сервер запущен: ${protocol}://localhost:${actualHttpsPort}`);

    if (isHttpsServer) {
        const redirectServer = http.createServer(httpApp);
        listenWithRetries(redirectServer, HTTP_PORT, MAX_PORT_TRIES, 'HTTP редирект', (httpPort) => {
            actualHttpPort = httpPort;
            console.log(`HTTP редирект: http://localhost:${actualHttpPort} -> https://localhost:${actualHttpsPort}`);
        });
    } else {
        console.log('HTTP редирект отключён, сервер работает без HTTPS');
    }
});