const http = require("http");
const { Bot, InlineKeyboard } = require("grammy");

// التوكن يجي من متغير البيئة، لا تكتبه هنا أبداً
const token = process.env.BOT_TOKEN;
if (!token) {
  throw new Error("المتغير BOT_TOKEN غير موجود");
}

const bot = new Bot(token);

function mainMenu() {
  return new InlineKeyboard()
    .text("📋 المهام", "tasks")
    .text("💰 رصيدي", "balance")
    .row()
    .text("🎁 الهدية اليومية", "daily")
    .text("👥 دعوة الأصدقاء", "invite");
}

bot.command("start", (ctx) =>
  ctx.reply("أهلاً بك 👋\nاختر من القائمة:", { reply_markup: mainMenu() })
);

// أزرار القائمة (ردود مؤقتة، نبنيها بعدين واحد واحد)
const placeholders = {
  tasks: "📋 قائمة المهام قريباً",
  balance: "💰 رصيدك: 0 نقطة",
  daily: "🎁 الهدية اليومية قريباً",
  invite: "👥 رابط الدعوة قريباً",
};

for (const [name, text] of Object.entries(placeholders)) {
  bot.callbackQuery(name, async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply(text, {
      reply_markup: new InlineKeyboard().text("⬅️ القائمة الرئيسية", "menu"),
    });
  });
}

bot.callbackQuery("menu", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply("اختر من القائمة:", { reply_markup: mainMenu() });
});

bot.catch((err) => console.error("خطأ:", err.error));

// سيرفر صغير جداً، بعض الاستضافات المجانية تطلبه عشان تعتبر الخدمة شغالة
http
  .createServer((req, res) => res.end("OK"))
  .listen(process.env.PORT || 3000);

bot.start();
