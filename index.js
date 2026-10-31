const http = require("http");
const { Pool } = require("pg");
const { Bot, InlineKeyboard } = require("grammy");

// ====== الإعدادات (غيّر الأرقام من هنا) ======
const POINTS_PER_USDT = 10000; // كل 10000 نقطة = 1 USDT
const MIN_WITHDRAW_USDT = 1; // الحد الأدنى للسحب
const DAILY_GIFT = 20; // نقاط الهدية اليومية
const INVITE_BONUS = 50; // نقاط الدعوة (بعد أول مهمة للمدعو)
const DEFAULT_REWARD = 100; // نقاط كل اشتراك
const FIRST_CHANNELS = ["@Fileslyzerox1", "@lyzerox1"];

// ====== المتغيرات السرية (من Render) ======
const token = process.env.BOT_TOKEN;
const dbUrl = (process.env.DATABASE_URL || "").replace(/^"|"$/g, "");
const ADMIN_ID = Number(process.env.ADMIN_ID);
if (!token) throw new Error("المتغير BOT_TOKEN غير موجود");
if (!dbUrl) throw new Error("المتغير DATABASE_URL غير موجود");
if (!ADMIN_ID) throw new Error("المتغير ADMIN_ID غير موجود");

const pool = new Pool({
  connectionString: dbUrl.split("?")[0],
  ssl: { rejectUnauthorized: false },
});
const bot = new Bot(token);
const waitingWallet = new Set();

const isAdmin = (ctx) => ctx.from && ctx.from.id === ADMIN_ID;
const backKb = () => new InlineKeyboard().text("⬅️ القائمة الرئيسية", "menu");

function mainMenu() {
  return new InlineKeyboard()
    .text("📋 المهام", "tasks")
    .text("💰 رصيدي", "balance")
    .row()
    .text("🎁 الهدية اليومية", "daily")
    .text("👥 دعوة الأصدقاء", "invite");
}

// ====== قاعدة البيانات ======
async function initDb() {
  await pool.query(`CREATE TABLE IF NOT EXISTS users (
    id BIGINT PRIMARY KEY,
    username TEXT,
    balance BIGINT NOT NULL DEFAULT 0,
    invited_by BIGINT,
    referral_paid BOOLEAN NOT NULL DEFAULT false,
    last_daily DATE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS tasks (
    id SERIAL PRIMARY KEY,
    channel TEXT UNIQUE NOT NULL,
    reward INT NOT NULL,
    active BOOLEAN NOT NULL DEFAULT true
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS completions (
    id SERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL,
    task_id INT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, task_id)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS withdrawals (
    id SERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL,
    points BIGINT NOT NULL,
    wallet TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  const { rows } = await pool.query("SELECT COUNT(*) FROM tasks");
  if (Number(rows[0].count) === 0) {
    for (const ch of FIRST_CHANNELS) {
      await pool.query(
        "INSERT INTO tasks (channel, reward) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        [ch, DEFAULT_REWARD]
      );
    }
  }
}

// تسجيل المستخدم تلقائياً عند أي تفاعل
bot.use(async (ctx, next) => {
  if (ctx.from) {
    const r = await pool.query(
      "INSERT INTO users (id, username) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING RETURNING id",
      [ctx.from.id, ctx.from.username || null]
    );
    ctx.isNew = r.rowCount > 0;
  }
  await next();
});

// ====== /start والقائمة ======
bot.command("start", async (ctx) => {
  const ref = Number(ctx.match);
  if (ctx.isNew && ref && ref !== ctx.from.id) {
    await pool.query(
      "UPDATE users SET invited_by = $1 WHERE id = $2 AND EXISTS (SELECT 1 FROM users WHERE id = $1)",
      [ref, ctx.from.id]
    );
  }
  await ctx.reply("أهلاً بك 👋\nاختر من القائمة:", { reply_markup: mainMenu() });
});

bot.callbackQuery("menu", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply("اختر من القائمة:", { reply_markup: mainMenu() });
});

// ====== المهام ======
async function showTasks(ctx) {
  const { rows } = await pool.query(
    `SELECT t.id, t.channel, t.reward FROM tasks t
     WHERE t.active AND NOT EXISTS (
       SELECT 1 FROM completions c WHERE c.task_id = t.id AND c.user_id = $1
     ) ORDER BY t.id`,
    [ctx.from.id]
  );
  if (!rows.length) {
    return ctx.reply("لا توجد مهام جديدة الآن 🎉\nارجع لاحقاً.", {
      reply_markup: backKb(),
    });
  }
  const kb = new InlineKeyboard();
  for (const t of rows) {
    kb.url(
      `📢 ${t.channel} (+${t.reward})`,
      `https://t.me/${t.channel.replace("@", "")}`
    )
      .text("✅ تحقق", `check:${t.id}`)
      .row();
  }
  kb.text("⬅️ القائمة الرئيسية", "menu");
  await ctx.reply("اشترك في القناة ثم اضغط «تحقق»:", { reply_markup: kb });
}

bot.callbackQuery("tasks", async (ctx) => {
  await ctx.answerCallbackQuery();
  await showTasks(ctx);
});

bot.callbackQuery(/^check:(\d+)$/, async (ctx) => {
  const taskId = Number(ctx.match[1]);
  const { rows } = await pool.query(
    "SELECT * FROM tasks WHERE id = $1 AND active",
    [taskId]
  );
  if (!rows.length) {
    return ctx.answerCallbackQuery({ text: "المهمة غير متاحة", show_alert: true });
  }
  const task = rows[0];

  let member;
  try {
    member = await ctx.api.getChatMember(task.channel, ctx.from.id);
  } catch (e) {
    console.error("getChatMember:", e.message);
    return ctx.answerCallbackQuery({
      text: "تعذر التحقق الآن، حاول لاحقاً",
      show_alert: true,
    });
  }
  if (!["member", "administrator", "creator"].includes(member.status)) {
    return ctx.answerCallbackQuery({ text: "لم تشترك بعد ❌", show_alert: true });
  }

  const ins = await pool.query(
    "INSERT INTO completions (user_id, task_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING id",
    [ctx.from.id, taskId]
  );
  if (!ins.rowCount) {
    return ctx.answerCallbackQuery({
      text: "أخذت مكافأة هذه المهمة من قبل",
      show_alert: true,
    });
  }
  await pool.query("UPDATE users SET balance = balance + $1 WHERE id = $2", [
    task.reward,
    ctx.from.id,
  ]);

  // مكافأة الدعوة: مرة واحدة فقط، بعد أول مهمة للمدعو
  const inv = await pool.query(
    "UPDATE users SET referral_paid = true WHERE id = $1 AND invited_by IS NOT NULL AND referral_paid = false RETURNING invited_by",
    [ctx.from.id]
  );
  if (inv.rowCount) {
    const inviter = inv.rows[0].invited_by;
    await pool.query("UPDATE users SET balance = balance + $1 WHERE id = $2", [
      INVITE_BONUS,
      inviter,
    ]);
    ctx.api
      .sendMessage(inviter, `🎉 صديق دعوته أنجز أول مهمة، أخذت ${INVITE_BONUS} نقطة`)
      .catch(() => {});
  }

  await ctx.answerCallbackQuery({ text: `+${task.reward} نقطة ✅` });
  await showTasks(ctx);
});

// ====== الرصيد ======
async function showBalance(ctx) {
  const { rows } = await pool.query("SELECT balance FROM users WHERE id = $1", [
    ctx.from.id,
  ]);
  const pts = Number(rows[0].balance);
  const usdt = (pts / POINTS_PER_USDT).toFixed(2);
  const kb = new InlineKeyboard()
    .text("💸 سحب", "withdraw")
    .row()
    .text("⬅️ القائمة الرئيسية", "menu");
  await ctx.reply(
    `💰 رصيدك: ${pts} نقطة (≈ ${usdt} USDT)\nالحد الأدنى للسحب: ${MIN_WITHDRAW_USDT} USDT`,
    { reply_markup: kb }
  );
}

bot.callbackQuery("balance", async (ctx) => {
  await ctx.answerCallbackQuery();
  await showBalance(ctx);
});

// ====== الهدية اليومية ======
bot.callbackQuery("daily", async (ctx) => {
  await ctx.answerCallbackQuery();
  const done = await pool.query(
    "SELECT 1 FROM completions WHERE user_id = $1 LIMIT 1",
    [ctx.from.id]
  );
  if (!done.rowCount) {
    return ctx.reply("🎁 الهدية اليومية تفتح بعد ما تنجز مهمة واحدة على الأقل.", {
      reply_markup: backKb(),
    });
  }
  const r = await pool.query(
    "UPDATE users SET balance = balance + $1, last_daily = CURRENT_DATE WHERE id = $2 AND (last_daily IS NULL OR last_daily < CURRENT_DATE) RETURNING balance",
    [DAILY_GIFT, ctx.from.id]
  );
  if (!r.rowCount) {
    return ctx.reply("أخذت هدية اليوم ✅\nارجع بكرة.", { reply_markup: backKb() });
  }
  await ctx.reply(`🎁 حصلت على ${DAILY_GIFT} نقطة!\nرصيدك: ${r.rows[0].balance} نقطة`, {
    reply_markup: backKb(),
  });
});

// ====== دعوة الأصدقاء ======
bot.callbackQuery("invite", async (ctx) => {
  await ctx.answerCallbackQuery();
  const link = `https://t.me/${ctx.me.username}?start=${ctx.from.id}`;
  const c = await pool.query(
    "SELECT COUNT(*) FROM users WHERE invited_by = $1 AND referral_paid = true",
    [ctx.from.id]
  );
  await ctx.reply(
    `👥 رابط الدعوة الخاص بك:\n${link}\n\nتحصل على ${INVITE_BONUS} نقطة عن كل صديق ينجز أول مهمة.\nعدد من أنجزوا: ${c.rows[0].count}`,
    { reply_markup: backKb() }
  );
});

// ====== السحب ======
bot.callbackQuery("withdraw", async (ctx) => {
  await ctx.answerCallbackQuery();
  const { rows } = await pool.query("SELECT balance FROM users WHERE id = $1", [
    ctx.from.id,
  ]);
  const pts = Number(rows[0].balance);
  const minPts = MIN_WITHDRAW_USDT * POINTS_PER_USDT;
  if (pts < minPts) {
    return ctx.reply(
      `رصيدك ${pts} نقطة، والحد الأدنى للسحب ${minPts} نقطة (${MIN_WITHDRAW_USDT} USDT).`,
      { reply_markup: backKb() }
    );
  }
  waitingWallet.add(ctx.from.id);
  await ctx.reply(
    "أرسل الآن عنوان محفظة USDT مع اسم الشبكة في رسالة واحدة.\nمثال: TRC20 ثم العنوان.\nسيتم سحب كامل رصيدك.\n\nللإلغاء أرسل /cancel"
  );
});

bot.command("cancel", async (ctx) => {
  waitingWallet.delete(ctx.from.id);
  await ctx.reply("تم الإلغاء.", { reply_markup: mainMenu() });
});

async function createWithdrawal(ctx, wallet) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const u = await client.query(
      "SELECT balance FROM users WHERE id = $1 FOR UPDATE",
      [ctx.from.id]
    );
    const pts = Number(u.rows[0].balance);
    if (pts < MIN_WITHDRAW_USDT * POINTS_PER_USDT) {
      await client.query("ROLLBACK");
      return null;
    }
    const w = await client.query(
      "INSERT INTO withdrawals (user_id, points, wallet) VALUES ($1, $2, $3) RETURNING id",
      [ctx.from.id, pts, wallet]
    );
    await client.query("UPDATE users SET balance = 0 WHERE id = $1", [ctx.from.id]);
    await client.query("COMMIT");
    return { id: w.rows[0].id, pts };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

bot.callbackQuery(/^wd_(ok|no):(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCallbackQuery();
  const action = ctx.match[1];
  const id = Number(ctx.match[2]);
  const status = action === "ok" ? "paid" : "rejected";
  const r = await pool.query(
    "UPDATE withdrawals SET status = $1 WHERE id = $2 AND status = 'pending' RETURNING user_id, points",
    [status, id]
  );
  if (!r.rowCount) {
    return ctx.answerCallbackQuery({ text: "تمت معالجته من قبل", show_alert: true });
  }
  const { user_id, points } = r.rows[0];
  if (action === "no") {
    await pool.query("UPDATE users SET balance = balance + $1 WHERE id = $2", [
      points,
      user_id,
    ]);
  }
  ctx.api
    .sendMessage(
      user_id,
      action === "ok"
        ? "✅ تم دفع طلب السحب الخاص بك."
        : "❌ تم رفض طلب السحب وأُعيدت النقاط لرصيدك."
    )
    .catch(() => {});
  await ctx.answerCallbackQuery({ text: action === "ok" ? "تم الدفع ✅" : "تم الرفض ❌" });
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
});

// ====== أوامر الأدمن ======
bot.command("addtask", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const [channel, reward] = ctx.match.split(/\s+/);
  if (!channel || !channel.startsWith("@")) {
    return ctx.reply("الصيغة: /addtask @channel 100");
  }
  await pool.query(
    "INSERT INTO tasks (channel, reward) VALUES ($1, $2) ON CONFLICT (channel) DO UPDATE SET reward = $2, active = true",
    [channel, Number(reward) || DEFAULT_REWARD]
  );
  await ctx.reply(`✅ تمت إضافة المهمة: ${channel}`);
});

bot.command("deltask", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const r = await pool.query("UPDATE tasks SET active = false WHERE channel = $1", [
    ctx.match.trim(),
  ]);
  await ctx.reply(r.rowCount ? "✅ تم إيقاف المهمة" : "المهمة غير موجودة");
});

bot.command("stats", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const u = await pool.query("SELECT COUNT(*) FROM users");
  const w = await pool.query("SELECT COUNT(*) FROM withdrawals WHERE status = 'pending'");
  await ctx.reply(`👤 المستخدمون: ${u.rows[0].count}\n💸 سحوبات معلقة: ${w.rows[0].count}`);
});

// ====== الرسائل النصية (عنوان المحفظة) ======
bot.on("message:text", async (ctx) => {
  if (waitingWallet.has(ctx.from.id)) {
    const wallet = ctx.message.text.trim();
    if (wallet.length < 10 || wallet.length > 200) {
      return ctx.reply("العنوان غير صحيح، أعد الإرسال أو أرسل /cancel");
    }
    waitingWallet.delete(ctx.from.id);
    const w = await createWithdrawal(ctx, wallet);
    if (!w) return ctx.reply("رصيدك لا يكفي للسحب.", { reply_markup: backKb() });
    await ctx.reply("✅ تم استلام طلب السحب، سيتم مراجعته قريباً.", {
      reply_markup: backKb(),
    });
    const usdt = (w.pts / POINTS_PER_USDT).toFixed(2);
    await ctx.api.sendMessage(
      ADMIN_ID,
      `💸 طلب سحب #${w.id}\nالمستخدم: ${ctx.from.id}\nالمبلغ: ${usdt} USDT (${w.pts} نقطة)\nالمحفظة:\n${wallet}`,
      {
        reply_markup: new InlineKeyboard()
          .text("✅ تم الدفع", `wd_ok:${w.id}`)
          .text("❌ رفض", `wd_no:${w.id}`),
      }
    );
    return;
  }
  await ctx.reply("اختر من القائمة:", { reply_markup: mainMenu() });
});

bot.catch((err) => console.error("خطأ:", err.error));

// سيرفر صغير جداً عشان الاستضافة المجانية تعتبر الخدمة شغالة
http
  .createServer((req, res) => res.end("OK"))
  .listen(process.env.PORT || 3000);

initDb()
  .then(() => {
    console.log("قاعدة البيانات جاهزة");
    bot.start();
  })
  .catch((e) => {
    console.error("فشل تجهيز قاعدة البيانات:", e);
    process.exit(1);
  });
