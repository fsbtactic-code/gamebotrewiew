/**
 * HezzlBot v7 — Next-Gen Match3 Autonomous Farm Bot
 * Features:
 * 1. Dynamic player ID extraction (no hardcoded incorrect IDs).
 * 2. Background clan life distribution & incoming claiming.
 * 3. Automatic 5-pack life purchasing using coins.
 * 4. Automatic unlimited lives detection.
 * 5. Expired stuck session bypass and self-healing.
 * 6. High-reward, safe and premium win payloads.
 */

const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CAMPAIGN_ID = '105862';
const RCS_SECRET = 'b3f1f5e2-6d4e-11ec-90d6-0242ac120003';
const MODE_ID = 89;
const BASE = 'https://api-prod.hezzl.ru';

// Color definitions for beautiful logging
const C = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    dim: '\x1b[2m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    red: '\x1b[31m',
    cyan: '\x1b[36m',
    magenta: '\x1b[35m',
    bgGreen: '\x1b[42m',
    bgBlue: '\x1b[44m'
};

const log = (icon, msg, color = '') => {
    console.log(`${C.dim}[${new Date().toLocaleTimeString('ru-RU')}]${C.reset} ${color}${icon} ${msg}${C.reset}`);
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ======================== STATE & INITIALIZATION ========================

let latestToken = ''; // Bearer or URL token
let accessToken = ''; // Access token from check-token
let playerId = '1682554426469909663'; // Fallback player ID
let serialCounter = 245; // serial=244 closed 185132815 (win), next=245
let hasUnlimitedLives = false;
let unlimitedLivesExpiredAt = null;

// Read the intercepted token from logs
function loadToken() {
    try {
        const file = path.join(__dirname, 'logs', 'latest_token.txt');
        if (fs.existsSync(file)) {
            latestToken = fs.readFileSync(file, 'utf8').trim();
            return true;
        }
    } catch (e) {
        log('❌', `Ошибка чтения токена: ${e.message}`, C.red);
    }
    return false;
}

// Generate the X-RCS signature
const xrcs = (s) => Buffer.from(
    crypto.createHash('sha1').update([RCS_SECRET, s, CAMPAIGN_ID, playerId].join('|')).digest('hex')
).toString('base64');

// Generate headers
const H = (s = null) => {
    const h = {
        'Authorization': accessToken || latestToken,
        'Content-Type': 'application/json',
        'Origin': 'https://play.hezzl.ru',
        'Referer': 'https://play.hezzl.ru/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    };
    if (s !== null) h['X-RCS'] = xrcs(s);
    return h;
};

// Simplified header
const Hbasic = () => ({
    'Authorization': accessToken || latestToken,
    'Content-Type': 'application/json',
    'Origin': 'https://play.hezzl.ru',
    'Referer': 'https://play.hezzl.ru/'
});

// Dynamic authentication & player info lookup
async function authenticate() {
    loadToken();
    if (!latestToken) {
        throw new Error('Токен в logs/latest_token.txt отсутствует!');
    }

    log('🔐', 'Проверка токена и авторизация...', C.yellow);
    const res = await axios.post(`${BASE}/auth/v1/game/${CAMPAIGN_ID}/check-token`, {}, {
        headers: {
            'Authorization': latestToken,
            'Origin': 'https://play.hezzl.ru',
            'Referer': 'https://play.hezzl.ru/',
            'Content-Type': 'application/json'
        }
    });

    accessToken = res.data.accessToken;
    if (res.data.player?.id) {
        playerId = res.data.player.id;
        log('👤', `Авторизован игрок: ${C.bright}${res.data.player.name}${C.reset} | ID: ${playerId}`, C.green);
    }
    if (res.data.verify?.serial != null) {
        serialCounter = res.data.verify.serial;
        log('🔄', `Синхронизирован начальный serial: ${serialCounter}`, C.green);
    }
}

// ======================== TOKEN REFRESH ========================

let tokenRefreshInterval = null;

// Обновить токен через /refresh-token (работает пока текущий токен валиден)
async function refreshToken() {
    try {
        const currentToken = accessToken || latestToken;
        if (!currentToken) {
            log('⚠️', 'refreshToken: нет токена для обновления', C.yellow);
            return false;
        }
        const res = await axios.post(`${BASE}/auth/v1/game/${CAMPAIGN_ID}/refresh-token`, {}, {
            headers: {
                'Authorization': currentToken,
                'Content-Type': 'application/json',
                'Origin': 'https://play.hezzl.ru',
                'Referer': 'https://play.hezzl.ru/'
            },
            timeout: 10000
        });
        if (res.data?.accessToken) {
            const newToken = res.data.accessToken;
            const expAt = res.data.accessTokenExpireAt;
            const expDate = expAt ? new Date(expAt) : null;
            const expHours = expDate ? ((expDate - Date.now()) / 3600000).toFixed(1) : '?';

            // Обновляем оба токена
            latestToken = newToken;
            accessToken = newToken;

            // Сохраняем в файл для персистентности
            try {
                const file = path.join(__dirname, 'logs', 'latest_token.txt');
                fs.writeFileSync(file, newToken, 'utf8');
            } catch (e) { /* ignore write errors */ }

            log('🔑', `Токен обновлён! Истекает через ${expHours}ч (${expDate?.toLocaleString('ru-RU') || '?'})`, C.green);
            return true;
        } else {
            log('⚠️', `refreshToken: неожиданный ответ: ${JSON.stringify(res.data).substring(0, 100)}`, C.yellow);
            return false;
        }
    } catch (e) {
        const msg = e.response?.data?.message || e.message;
        log('❌', `refreshToken ошибка: ${msg}`, C.red);
        return false;
    }
}

// Запуск автоматического обновления токена каждые 20 часов
function startAutoRefresh() {
    if (tokenRefreshInterval) clearInterval(tokenRefreshInterval);
    const REFRESH_INTERVAL_MS = 20 * 60 * 60 * 1000; // 20 часов
    tokenRefreshInterval = setInterval(async () => {
        log('🔄', 'Плановое обновление токена (каждые 20ч)...', C.cyan);
        const ok = await refreshToken();
        if (!ok) {
            log('❌', 'Не удалось обновить токен автоматически! Требуется ручное обновление.', C.red);
        }
    }, REFRESH_INTERVAL_MS);
    log('✅', `Авто-обновление токена запущено (интервал: 20ч)`, C.green);
}

async function syncSerial() {
    try {
        const r = await axios.get(`${BASE}/games/v1/game/progress?campaignId=${CAMPAIGN_ID}`, { headers: H() });
        if (r.data?.serial != null) {
            serialCounter = r.data.serial;
            log('🔄', `Синхронизирован serial из progress: ${serialCounter}`, C.green);
        }
        if (r.data?.session?.id) {
            log('⚠️', `Обнаружена активная сессия при старте: ${r.data.session.id}`, C.yellow);
        }
    } catch (e) {
        log('⚠️', `syncSerial ошибка: ${e.message}`, C.yellow);
    }
}

async function getLiveSerial() {
    try {
        const r = await axios.get(`${BASE}/games/v1/game/progress?campaignId=${CAMPAIGN_ID}`, { headers: H() });
        if (r.data?.serial != null) {
            serialCounter = r.data.serial;
        }
    } catch (e) {
        log('⚠️', `getLiveSerial ошибка: ${e.message}`, C.yellow);
    }
    return serialCounter;
}

// ======================== BALANCES & STATUS ========================

async function updateBalancesAndBooster() {
    try {
        const r = await axios.get(`${BASE}/balance/v1/game/get-balance`, { headers: H() });
        // API returns { balance: [...] } — note: key is 'balance' not 'balances'
        const balances = r.data.balance || r.data.balances || (Array.isArray(r.data) ? r.data : []);

        const coinsInfo  = balances.find(b => b.resourceId === 748);
        const livesInfo  = balances.find(b => b.resourceId === 750);
        const coins = coinsInfo?.value || 0;
        const lives = livesInfo?.value || 0;

        // Check for unlimited lives
        if (livesInfo?.unlimitedAt) {
            const exp = new Date(livesInfo.unlimitedAt);
            if (exp.getTime() > Date.now() && exp.getFullYear() > 2000) {
                hasUnlimitedLives = true;
                unlimitedLivesExpiredAt = exp;
                log('⚡', `Обнаружен БЕЗЛИМИТ жизней! Действует до: ${exp.toLocaleTimeString('ru-RU')}`, C.green + C.bright);
            } else {
                hasUnlimitedLives = false;
            }
        } else {
            hasUnlimitedLives = false;
        }

        return { coins, lives, raw: balances };
    } catch (e) {
        log('❌', `Не удалось обновить балансы: ${e.message}`, C.red);
        return { coins: 0, lives: 0, raw: [] };
    }
}

// ======================== LIVES EXCHANGER ========================

async function claimAllIncoming() {
    try {
        const r = await axios.get(`${BASE}/balance/v1/game/exchange-progress`, { headers: H() });
        const senders = (r.data.exchangeSenders || []).filter(s => s.typeId === 750);
        if (senders.length === 0) return 0;
        
        let total = 0;
        for (const sender of senders) {
            try {
                const s = await getLiveSerial();
                const res = await axios.post(
                    `${BASE}/balance/v1/game/exchange/claim`,
                    { senderIds: [sender.id] },
                    { headers: H(s) }
                );
                if (res.data?.serial != null) {
                    serialCounter = res.data.serial;
                }
                const accrual = res.data?.updatedBalance?.accrual || [];
                const got = accrual.filter(a => a.resourceId === 750).reduce((s, a) => s + (a.value || 0), 0);
                total += got;
                if (got > 0) log('📥', `Жизнь от ${sender.senderId} (+${got})`);
            } catch (e) {}
            await sleep(100);
        }
        return total;
    } catch (e) { return 0; }
}

async function getClanExchangeRequests(clanId) {
    try {
        const r = await axios.post(
            `${BASE}/balance/v1/game/exchange/get-request`,
            {},
            { headers: Hbasic(), params: { groupKey: `CLAN_${clanId}` } }
        );
        return r.data.requests || [];
    } catch (e) { return []; }
}

async function massLifeSendCycle() {
    log('🌍', 'Запуск массовой рассылки жизней по кланам сервера...', C.cyan);
    let clans = [];
    try {
        const r = await axios.post(`${BASE}/clans/v1/game/list`, {}, { headers: Hbasic(), params: { limit: 1000 } });
        clans = r.data.result || [];
    } catch (e) { return 0; }

    const now = Date.now();
    let sent = 0;

    for (const clan of clans) {
        const requests = await getClanExchangeRequests(clan.id);
        const eligible = requests.filter(req =>
            req.playerId !== playerId &&
            !req.completed &&
            !(req.senders || []).includes(playerId) &&
            req.typeId === 750 &&
            !(req.loopExpiredAt && new Date(req.loopExpiredAt).getTime() < now)
        );

        for (const req of eligible) {
            try {
                const s = await getLiveSerial();
                const res = await axios.post(
                    `${BASE}/balance/v1/game/exchange/send`,
                    {},
                    { headers: H(s), params: { requestId: req.id } }
                );
                if (res.data?.serial != null) {
                    serialCounter = res.data.serial;
                }
                sent++;
                log('📤', `→ ${req.playerId} (клан: ${clan.title}) [итого: ${sent}]`);
            } catch (e) {}
            await sleep(150);
        }
    }

    if (sent > 0) log('✅', `Успешно отправлено ${sent} жизней по ${clans.length} кланам!`, C.green);
    return sent;
}

// Purchase pack of lives via showcase
// CONFIRMED from real traffic: serial goes in BOTH ?serial=N query param AND X-RCS header
async function buyLife() {
    try {
        log('🛒', 'Синхронизируем serial с сервером перед покупкой...', C.yellow);
        const serverSerial = await getLiveSerial();
        log('💰', `Синхронизировано! Покупаем жизни с serial=${serverSerial}...`, C.yellow);

        const res = await axios.post(
            `${BASE}/boxes/v1/game/showcase/1564/reward/0/give`,
            {},
            {
                headers: H(serverSerial),
                params: { x: 1, serial: serverSerial }  // x=1 обязателен, x=0 даёт validation error
            }
        );

        // Обновляем наш локальный serialCounter
        if (res.data?.serial != null) {
            serialCounter = res.data.serial;
        } else {
            serialCounter = serverSerial + 1;
        }

        const balances = res.data?.updatedBalance?.balances || res.data?.updatedBalance?.balance || [];
        const livesAfter = balances.find(b => b.resourceId === 750)?.value;
        const coinsAfter = balances.find(b => b.resourceId === 748)?.value;
        log('🎁', `Жизни куплены! Жизней: ${livesAfter} | Монет: ${coinsAfter} | serial: ${serialCounter}`, C.bgGreen + C.reset + C.bright);
        return true;
    } catch (e) {
        log('❌', `Ошибка покупки жизней: ${e.response?.data?.message || e.message}`, C.red);
        if (e.response?.data) {
            log('❌', `Детали ответа сервера: ${JSON.stringify(e.response.data)}`, C.red);
        }
        return false;
    }
}

async function autoClaimRewards() {
    try {
        log('🎁', 'Проверка доступных наград для автоматического сбора...', C.cyan);
        
        // 1. Получаем текущий прогресс
        const progRes = await axios.get(`${BASE}/boxes/v1/game/progress`, { headers: H() });
        const progress = progRes.data;

        // 2. Обрабатываем Seasonbox (Сезонный пропуск)
        const seasonbox = progress.seasonboxProgress?.find(sb => sb.seasonboxId === 20);
        if (seasonbox) {
            const claimed = new Set(seasonbox.issuedLevelRewards || []);
            let rewardId = 1037; // Начальный ID наград
            
            // Находим первый неполученный ID
            while (claimed.has(rewardId)) {
                rewardId++;
            }
            
            // Пробуем собирать награды последовательно, пока не наткнемся на закрытую
            let claimedAny = false;
            while (rewardId < 1200) { // разумный верхний предел
                log('🎁', `Пробуем забрать награду Seasonbox ID: ${rewardId}...`, C.yellow);
                const s = await getLiveSerial();
                try {
                    const res = await axios.post(
                        `${BASE}/boxes/v1/game/seasonbox/20/reward/${rewardId}/give`,
                        {},
                        {
                            headers: H(s),
                            params: { serial: s }
                        }
                    );
                    
                    if (res.data?.serial != null) {
                        serialCounter = res.data.serial;
                    }
                    
                    const accrual = res.data?.updatedBalance?.accrual || [];
                    const rewardsStr = accrual.map(a => `ID ${a.resourceId}: +${a.value}`).join(', ') || 'награда получена';
                    log('🎉', `Успешно получена награда Seasonbox ID ${rewardId}! (${rewardsStr})`, C.green + C.bright);
                    
                    claimed.add(rewardId);
                    rewardId++;
                    claimedAny = true;
                    await sleep(800); // небольшая пауза
                } catch (err) {
                    const msg = err.response?.data?.message || err.message;
                    if (msg === 'errors.boxes.seasonbox.resourceRequire') {
                        log('🔒', `Награда ID ${rewardId} ещё заблокирована (требуется прохождение уровней). Останавливаем сбор.`, C.dim);
                    } else {
                        log('⚠️', `Не удалось забрать награду ID ${rewardId}: ${msg}`, C.yellow);
                    }
                    break;
                }
            }
            if (!claimedAny) {
                log('✅', 'Все доступные награды Seasonbox уже собраны.', C.dim);
            }
        }
    } catch (e) {
        log('⚠️', `Ошибка авто-сбора наград: ${e.message}`, C.yellow);
    }
}

async function autoClaimNewRewards() {
    try {
        log('🎁', 'Проверка новых наград (my-awards) для автоматического сбора...', C.cyan);
        
        const res = await axios.get(`${BASE}/rewards-new/v1/game/my-awards`, { headers: H() });
        const pendingRewards = (res.data.myRewards || []).filter(r => r.status === 'rewarding');
        
        if (pendingRewards.length === 0) {
            log('✅', 'Все новые награды (my-awards) уже собраны.', C.dim);
            return;
        }
        
        log('🎁', `Найдено ${pendingRewards.length} доступных наград для сбора.`, C.yellow);
        
        for (const r of pendingRewards) {
            const s = await getLiveSerial();
            log('🎁', `Собираем награду ID ${r.id} (rewardId: ${r.rewardId}) с serial=${s}...`, C.yellow);
            try {
                const claimRes = await axios.post(
                    `${BASE}/rewards-new/v1/game/player-reward-new/${r.id}/get`,
                    {},
                    {
                        headers: H(s),
                        params: { serial: s }
                    }
                );
                
                if (claimRes.data?.serial != null) {
                    serialCounter = claimRes.data.serial;
                }
                
                log('🎉', `Успешно получена награда ID ${r.id}!`, C.green + C.bright);
            } catch (err) {
                log('⚠️', `Не удалось забрать награду ID ${r.id}: ${err.response?.data?.message || err.message}`, C.yellow);
            }
            await sleep(1500); // безопасный интервал
        }
    } catch (e) {
        log('⚠️', `Ошибка авто-сбора новых наград: ${e.message}`, C.yellow);
    }
}

function getNextCubesMasterMove(board) {
    const comboElements = [17, 2, 62, 41];
    
    // Helper to count occurrences
    const counts = {};
    for (const x of board) {
        counts[x] = (counts[x] || 0) + 1;
    }
    
    // 1. Check if there are any 3-matches already on the board (safety cleanup)
    for (const x of board) {
        if (counts[x] >= 3) {
            const newBoard = board.filter(item => item !== x);
            return { newBoard, xscores: 6 };
        }
    }
    
    // 2. If board is empty, we must populate it. We start by adding the first combo element.
    if (board.length === 0) {
        return { newBoard: [comboElements[0]], xscores: 0 };
    }
    
    // 3. If board has elements but their count is all 1, and size is less than 4,
    // we continue populating the board.
    const maxCount = Math.max(...Object.values(counts));
    if (maxCount === 1 && board.length < 4) {
        // Find the first combo element not in board
        const nextElem = comboElements.find(el => !board.includes(el));
        if (nextElem !== undefined) {
            return { newBoard: [...board, nextElem], xscores: 0 };
        }
    }
    
    // 4. Otherwise, we do greedy matching.
    const E = board[0];
    const count = counts[E];
    if (count === 1) {
        return { newBoard: [...board, E], xscores: 0 };
    } else if (count === 2) {
        return { newBoard: board.filter(item => item !== E), xscores: 6 };
    }
    
    // Fallback
    return { newBoard: [], xscores: 0 };
}

async function autoPlayCubesMaster() {
    try {
        // 1. Получаем балансы и проверяем токены (ресурс 823)
        const rBal = await axios.get(`${BASE}/balance/v1/game/get-balance`, { headers: H() });
        const balances = rBal.data.balance || rBal.data.balances || [];
        const tokenInfo = balances.find(b => b.resourceId === 823);
        let tokens = tokenInfo?.value || 0;
        
        if (tokens === 0) {
            log('🎲', 'Нет токенов Cubes Master (ресурс 823). Пропускаем авто-игру.', C.dim);
            return;
        }
        
        log('🎲', `Найдено ${tokens} токенов Cubes Master. Начинаем авто-игру...`, C.cyan);
        
        while (tokens > 0) {
            // 2. Получаем текущую доску
            const progRes = await axios.get(`${BASE}/mechanics/v1/game/progress`, { headers: H() });
            const mover = progRes.data.moverProgress?.find(m => m.moverId === 7);
            if (!mover) {
                log('⚠️', 'Mover 7 не найден в прогрессе mechanics.', C.yellow);
                break;
            }
            
            const currentBoard = mover.data?.board || [];
            log('🎲', `Текущая доска Cubes Master: [${currentBoard.join(', ')}] | Токенов осталось: ${tokens}`, C.cyan);
            
            // 3. Вычисляем следующий ход с комбо-стратегией
            const { newBoard, xscores } = getNextCubesMasterMove(currentBoard);
            
            const s = await getLiveSerial();
            if (xscores > 0) {
                log('🎯', `Событие: СБОР КОМБО! Отправляем ход с xscores=${xscores}, serial=${s}...`, C.green + C.bright);
            } else {
                log('🎲', `Отправляем ход Cubes Master с serial=${s}...`, C.yellow);
            }
            
            const res = await axios.post(
                `${BASE}/mechanics/v1/game/movers/7/update`,
                {
                    data: { board: newBoard },
                    reset: false,
                    xscores: xscores,
                    serial: s
                },
                {
                    headers: H(s),
                    params: { serial: s }
                }
            );
            
            if (res.data?.serial != null) {
                serialCounter = res.data.serial;
            }
            
            const totalScores = res.data?.progress?.xscores || 'обновлено';
            log('🎉', `Успешный ход! Общие очки: ${totalScores} | serial: ${serialCounter}`, C.green);
            
            // Уменьшаем счетчик токенов из ответа сервера
            const updatedTokenInfo = res.data?.updatedBalance?.balances?.find(b => b.resourceId === 823);
            tokens = updatedTokenInfo !== undefined ? updatedTokenInfo.value : tokens - 1;
            
            await sleep(1500); // 1.5 секунды между ходами для красивого комбо
        }
    } catch (e) {
        const errMsg = e.response?.data?.message || e.message;
        log('⚠️', `Не удалось сделать ход Cubes Master: ${errMsg}`, C.yellow);
        await syncSerial();
    }
}


// ======================== SESSION MANAGEMENT ========================

// Текущий уровень игрока (читается из modeProgress.lastLevelPriority)
let currentLevelPriority = null;

async function fetchCurrentLevel() {
    try {
        const rp = await axios.get(`${BASE}/games/v1/game/progress?campaignId=${CAMPAIGN_ID}`, { headers: H() });
        const mp = (rp.data?.modeProgress || []).find(m => m.modeId === MODE_ID) || rp.data?.modeProgress;
        const lp = mp?.lastLevelPriority;
        if (lp != null) {
            currentLevelPriority = lp + 1; // следующий уровень после последнего пройденного
            log('📶', `Текущий уровень: ${currentLevelPriority} (lastLevelPriority=${lp})`, C.dim);
        }
    } catch (e) {
        log('⚠️', `Не удалось получить уровень: ${e.message}`, C.yellow);
    }
}

async function startSession() {
    // Сервер требует levelPriority = lastLevelPriority + 1 (следующий уровень).
    // Без него — errors.validation.entityId. Нельзя слать пустой {}.
    if (currentLevelPriority == null) {
        await fetchCurrentLevel();
    }
    const levelPriority = currentLevelPriority || 47; // fallback на 47 если нет данных
    const r = await axios.post(`${BASE}/games/v1/game/session/${MODE_ID}/start`,
        { levelPriority }, { headers: H() });
    if (r.data?.serial != null) {
        serialCounter = r.data.serial;
        log('🔄', `Serial из /start: ${serialCounter}`, C.dim);
    } else if (r.data?.modeProgress?.serial != null) {
        serialCounter = r.data.modeProgress.serial;
        log('🔄', `Serial из /start modeProgress: ${serialCounter}`, C.dim);
    }
    // После успешного старта — обновляем уровень из ответа если есть
    const endMp = r.data?.modeProgress;
    if (endMp?.lastLevelPriority != null) {
        currentLevelPriority = endMp.lastLevelPriority + 1;
    }
    // Session data is nested under .session key
    const session = r.data?.session || r.data;
    return session;
}

// Valid item keys confirmed from real server traffic
const VALID_ITEM_KEYS = new Set([
    'star', 'leaf', 'rocket', 'mega', 'shield', 'lightning',
    'copter', 'disco', 'win', 'plate', 'glass_cup', 'mail',
    'bomb', 'fire', 'ice', 'wood', 'stone', 'sun', 'moon',
    'grass', 'flower', 'cloud', 'drop', 'bird', 'fish', 'bear'
]);

// Build result array from actual session level items (deduplicated by key with summed values)
// Falls back to proven real-traffic values if session has no items
function buildResultFromSession(session, goals) {
    const counts = {};

    // Count items present on the board from gameConfig
    const items = session?.levelData?.gameConfig?.items || [];
    for (const item of items) {
        if (item.key && VALID_ITEM_KEYS.has(item.key)) {
            counts[item.key] = (counts[item.key] || 0) + 1;
        }
    }

    // Always include goal keys (they must appear in result with >= goal.value)
    for (const g of goals) {
        const needed = g.value || 0;
        if (!counts[g.key] || counts[g.key] < needed) {
            counts[g.key] = needed;
        }
    }

    // Always mark win
    counts['win'] = 1;

    // Add maximized but safe realistic booster explosions and items
    if (!counts['mega'])      counts['mega']      = 400 + Math.floor(Math.random() * 50);
    if (!counts['lightning']) counts['lightning'] = 100 + Math.floor(Math.random() * 20);
    if (!counts['leaf'])      counts['leaf']      = 150 + Math.floor(Math.random() * 30);
    if (!counts['star'])      counts['star']      = 130 + Math.floor(Math.random() * 30);
    if (!counts['shield'])    counts['shield']    = 120 + Math.floor(Math.random() * 20);
    if (!counts['copter'])    counts['copter']    = 35  + Math.floor(Math.random() * 10);
    if (!counts['rocket'])    counts['rocket']    = 25  + Math.floor(Math.random() * 10);
    if (!counts['bomb'])      counts['bomb']      = 30  + Math.floor(Math.random() * 10);
    if (!counts['disco'])     counts['disco']     = 10  + Math.floor(Math.random() * 5);

    // Convert to array, slight random variance to avoid identical fingerprint each round
    return Object.entries(counts).map(([key, value]) => ({
        key,
        value: key === 'win' ? 1 : value + Math.floor(Math.random() * 3)
    }));
}

function makePremiumWinPayload(serial, goals, session) {
    const result = buildResultFromSession(session, goals);

    const leftGoals = {};
    for (const g of goals) {
        leftGoals[g.key] = 0; // All goals completed
    }

    return {
        closeSession: false,
        result,
        leftGoals,
        keepLimit: 50,  // Correct value from real traffic (was 28 — fixed)
        custom: 0,
        serial
    };
}

async function endSession(sessionId, serial, goals, session) {
    const payload = makePremiumWinPayload(serial, goals, session);
    try {
        const r = await axios.post(
            `${BASE}/games/v1/game/session/${sessionId}/end`,
            payload,
            { headers: H(serial) }
        );
        if (r.data?.serial != null) {
            serialCounter = r.data.serial;
            log('🔄', `Serial обновлён: ${serialCounter}`, C.dim);
        }
        // Обновляем текущий уровень из ответа /end
        const endLp = r.data?.modeProgress?.lastLevelPriority;
        if (endLp != null) {
            currentLevelPriority = endLp + 1;
            log('📶', `Следующий уровень: ${currentLevelPriority}`, C.dim);
        }
        return r.data;
    } catch (firstErr) {
        if (firstErr.response?.status !== 500) throw firstErr;

        // 500 — скорее всего serial расхождение. Перебираем ±15
        log('🔍', `500 на /end serial=${serial}. Подбираем правильный serial...`, C.yellow);
        const start = Math.max(1, serial - 15);
        const end   = serial + 5;
        for (let s = start; s <= end; s++) {
            if (s === serial) continue; // уже пробовали
            try {
                const p2 = makePremiumWinPayload(s, goals, session);
                const r2 = await axios.post(
                    `${BASE}/games/v1/game/session/${sessionId}/end`,
                    p2,
                    { headers: H(s) }
                );
                if (r2.data?.serial != null) {
                    serialCounter = r2.data.serial;
                }
                log('✅', `Serial найден: ${s} → следующий: ${serialCounter}`, C.green);
                return r2.data;
            } catch (_) { /* пробуем следующий */ }
        }
        throw firstErr; // все варианты не подошли
    }
}

// ======================== BOT AUTOMATION LOOP ========================

async function run() {
    console.log('\n' + '═'.repeat(60));
    console.log('        🚀 HezzlBot v7 — AUTOPILOT PREMIUM FARMER');
    console.log('         (Lives distribution, auto-buying, dynamic ID)');
    console.log('═'.repeat(60) + '\n');

    await authenticate();
    await syncSerial();
    startAutoRefresh(); // 🔑 Авто-обновление токена каждые 20ч

    let winsCount = 0;
    let coinsGained = 0;
    let lastLifeSend = 0;

    // Immediately claim and send lives at startup
    const initClaimed = await claimAllIncoming();
    if (initClaimed > 0) log('📥', `Получено ${initClaimed} входящих жизней при запуске`);
    await massLifeSendCycle();
    lastLifeSend = Date.now();

    // Сразу забираем любые накопленные награды при запуске
    await autoClaimRewards();
    await autoClaimNewRewards();
    await autoPlayCubesMaster();

    for (let round = 1; round <= 10000; round++) {
        console.log(`\n${'─'.repeat(50)}`);

        // Синхронизируем serial перед началом каждого раунда
        await syncSerial();

        // Check if 5 minutes have passed to send/claim hearts
        if (Date.now() - lastLifeSend > 5 * 60 * 1000) {
            const claimed = await claimAllIncoming();
            if (claimed > 0) log('📥', `Получено ${claimed} ответных жизней`, C.green);
            await massLifeSendCycle();
            lastLifeSend = Date.now();
        }

        // Fetch latest balances and update unlimited status
        const { coins, lives, raw } = await updateBalancesAndBooster();
        log('💎', `РАУНД ${round} | Монеты: ${coins} | Жизни: ${hasUnlimitedLives ? 'БЕЗЛИМИТ' : lives} | Побед: ${winsCount} | Профит: +${coinsGained} монет`, C.magenta);

        // If no lives and not unlimited, try to get lives
        if (lives === 0 && !hasUnlimitedLives) {
            log('🛒', 'Жизней нет. Проверяем входящие от клана...', C.yellow);

            // 1. СНАЧАЛА — собираем входящие жизни от клана (бесплатно)
            const claimed = await claimAllIncoming();
            if (claimed > 0) {
                log('📥', `Собрано ${claimed} жизней от клана! Продолжаем.`, C.green);
                continue;
            }

            // 2. ТОЛЬКО ЕСЛИ клан не дал — покупаем за монеты
            if (coins >= 300) {
                log('💰', 'Входящих нет. Покупаем 5 жизней за 300 монет...', C.yellow);
                const gotLives = await buyLife();
                if (gotLives) {
                    await sleep(1500);
                    continue;
                }
            }

            // 3. Fallback: ждём восстановления, каждые 15с опрашиваем клан
            const livesInfo = raw.find(b => b.resourceId === 750);
            const recoverAt = livesInfo?.recoverAt ? new Date(livesInfo.recoverAt) : null;
            const secLeft = recoverAt ? Math.max(0, Math.floor((recoverAt - Date.now()) / 1000)) : 60;
            const waitUntil = Date.now() + Math.max(30000, secLeft * 1000 + 2000);
            log('😴', `Нет жизней и монет. Восстановление через: ${secLeft}с. Жду входящих каждые 15с...`, C.dim);

            while (Date.now() < waitUntil) {
                await sleep(15000);
                const polled = await claimAllIncoming();
                if (polled > 0) {
                    log('📥', `Поймал ${polled} жизней от клана! Продолжаем.`, C.green);
                    break;
                }
                const secRemain = Math.max(0, Math.floor((waitUntil - Date.now()) / 1000));
                if (secRemain > 0) log('⏳', `Жизней ещё нет. Осталось ~${secRemain}с...`, C.dim);
            }
            continue;

        }

        // Start gameplay session
        let session = null;
        try {
            session = await startSession();
            if (!session?.id) {
                log('⚠️', `/start вернул без ID. Ищем в progress...`, C.yellow);
                const rp = await axios.get(`${BASE}/games/v1/game/progress?campaignId=${CAMPAIGN_ID}`, { headers: H() });
                if (rp.data?.session?.id) {
                    session = rp.data.session;
                    if (rp.data.modeProgress?.[0]?.loopSessions != null) serialCounter = rp.data.modeProgress[0].loopSessions;
                    log('▶️', `Сессия из progress: ${session.id}`, C.cyan);
                } else {
                    throw new Error('ID сессии не найден');
                }
            } else {
            log('▶️', `Начата сессия ${session.id} | serial: ${serialCounter} | Уровень: ${session.levelData?.priority ?? '?'} (id:${session.modeData?.levelId ?? '?'}) | Цели: ${(session.levelData?.goals || []).map(g => `${g.key}:${g.value}`).join(', ')}`, C.cyan);
            }
        } catch (e) {
            const msg = e.response?.data?.message || e.message;

            if (msg?.includes('sessionStarted')) {
                // Есть активная сессия — берём её из progress и используем напрямую
                const rProg = await axios.get(`${BASE}/games/v1/game/progress?campaignId=${CAMPAIGN_ID}`, { headers: H() });
                const activeS = rProg.data?.session;
                if (rProg.data?.serial) serialCounter = rProg.data.serial;

                if (activeS?.id) {
                    log('♻️', `Переиспользуем активную сессию ${activeS.id} напрямую...`, C.cyan);
                    // Симулируем gameplay время (13с во всех режимах)
                    await sleep(13000);
                    const s = await getLiveSerial();
                    const goals = activeS.levelData?.goals || [
                        { key: 'plate', value: 48 }, { key: 'glass_cup', value: 32 }, { key: 'mail', value: 25 }
                    ];
                    try {
                        const endData = await endSession(activeS.id, s, goals, activeS);
                        if (endData?.serial) serialCounter = endData.serial;
                        const balancesFromEnd2 = endData?.updatedBalance?.balances || endData?.updatedBalance?.accrual || [];
                        let coinsGot2 = balancesFromEnd2.find(a => a.resourceId === 748)?.value || 0;
                        if (coinsGot2 === 0) {
                            try {
                                const fb = await axios.get(`${BASE}/balance/v1/game/get-balance`, { headers: H() });
                                coinsGot2 = (fb.data.balance||fb.data.balances||[]).find(b=>b.resourceId===748)?.value || 0;
                            } catch (_) {}
                        }
                        const xscores2 = endData?.awardXscores || 0;
                        log('🎉', `ПОБЕДА переиспользование! Монет: ${coinsGot2} | XScore: +${xscores2}`, C.bgGreen + C.reset + C.bright);
                        winsCount++;
                        coinsGained = coinsGot2;

                        // Награды собираем всегда. Cubes Master — только без безлимита
                        await autoClaimRewards();
                        await autoClaimNewRewards();
                        if (!hasUnlimitedLives) {
                            await autoPlayCubesMaster();
                        } else {
                            log('⚡', 'Безлимит: Cubes Master пропускаем.', C.dim);
                        }
                    } catch (endErr) {
                        const errCode = endErr.response?.status;
                        const errMsg = endErr.response?.data?.message || endErr.message;
                        log('⚠️', `Не удалось завершить сессию ${activeS.id} (${errCode}: ${errMsg}). Пропускаем.`, C.yellow);
                        // При 500 — сессия уже закрыта или заблокирована, пропускаем без ожидания
                        if (errCode === 500) {
                            log('🔄', 'Сессия недоступна — стартуем новую.', C.dim);
                        } else {
                            await sleep(5000);
                        }
                    }
                } else {
                    await sleep(5000);
                }
                continue;
            }

            if (msg?.includes('notEnough') || msg?.includes('balance')) {
                log('😴', 'Нет жизней. Ждем 30с...', C.dim);
                await sleep(30000);
            } else if (e.code === 'ENOTFOUND' || e.code === 'ECONNREFUSED' || e.code === 'ETIMEDOUT' || e.code === 'ECONNRESET') {
                log('🌐', `Сетевая ошибка (${e.code}): ${msg}. Ждём 15с...`, C.yellow);
                await sleep(15000);
            } else {
                log('❌', `/start ошибка: ${msg || e.code || 'неизвестная'}`, C.red);
                if (msg?.includes('fraud')) {
                    log('⚠️', 'Антифрод сработал. Ожидаем 30с перед следующей попыткой...', C.yellow);
                    await sleep(30000);
                } else {
                    await sleep(5000);
                }
            }
            continue;
        }

        // Небольшая пауза перед игрой при безлимите — антифрод
        if (hasUnlimitedLives) await sleep(3000);

        // Simulating gameplay duration to pass server verification
        log('⏱️', `Симуляция игрового процесса (13 сек)${hasUnlimitedLives ? ' ⚡ БЕЗЛИМИТ' : ''}...`, C.dim);
        await sleep(13000);

        // Win and complete game session
        const s = await getLiveSerial();
        const goals = session.levelData?.goals || [
            { key: 'plate', value: 48 },
            { key: 'glass_cup', value: 32 },
            { key: 'mail', value: 25 }
        ];

        try {
            log('🏆', `Завершение сессии ${session.id} с победой (serial=${s})...`);
            const endData = await endSession(session.id, s, goals, session);
            if (endData?.serial) serialCounter = endData.serial;

            // Реальный ответ /end: { updatedBalance: { balances: [...] }, awardXscores: N, serial: N }
            // НЕТ поля 'accrual' — монеты (748) читаем из balances или из get-balance
            const balancesFromEnd = endData?.updatedBalance?.balances || endData?.updatedBalance?.accrual || [];
            let coinsGot = balancesFromEnd.find(a => a.resourceId === 748)?.value || 0;
            const xscores = endData?.awardXscores || 0;
            const lastSessionLost = endData?.lastSessionLost ?? false;

            // Если монеты не вернулись в /end — считываем из get-balance
            if (coinsGot === 0) {
                try {
                    const freshBal = await axios.get(`${BASE}/balance/v1/game/get-balance`, { headers: H() });
                    const freshBalances = freshBal.data.balance || freshBal.data.balances || [];
                    coinsGot = freshBalances.find(b => b.resourceId === 748)?.value || 0;
                } catch (_) {}
            }

            log('🎉', `УСПЕШНАЯ ПОБЕДА! Монет: ${coinsGot} | XScore: +${xscores} | Lost: ${lastSessionLost} (serial=${s})`, C.bgGreen + C.reset + C.bright);
            winsCount++;
            coinsGained = coinsGot; // Текущий баланс (не прирост)

            // Автоматически забираем награды после прохождения уровня
            // Награды собираем всегда. Cubes Master — только без безлимита
            await autoClaimRewards();
            await autoClaimNewRewards();
            if (!hasUnlimitedLives) {
                await autoPlayCubesMaster();
            } else {
                log('⚡', 'Безлимит: Cubes Master пропускаем.', C.dim);
            }
        } catch (e) {
            const errCode = e.response?.data?.code;
            const errMsg = e.response?.data?.message || e.message;
            log('❌', `Ошибка завершения игры (${errCode}): ${errMsg}`, C.red);
            await sleep(3000);
        }

        await sleep(2000);
    }
}

run().catch(e => {
    console.error('Критический сбой бота:', e.message);
    process.exit(1);
});
