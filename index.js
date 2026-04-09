const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  SlashCommandBuilder,
  PermissionFlagsBits,
  REST,
  Routes,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");
const Parser = require("rss-parser");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

// ─── Config ───────────────────────────────────────────────────────────────────
const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const CHECK_INTERVAL_MINUTES = parseInt(process.env.CHECK_INTERVAL_MINUTES) || 30;
// Comma-separated Discord User IDs jo setchannel use kar sakein
const ALLOWED_USER_IDS = (process.env.ALLOWED_USER_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);

const DATA_DIR = path.join(__dirname, "data");
const SENT_FILE = path.join(DATA_DIR, "sent_updates.json");
const CHANNELS_FILE = path.join(DATA_DIR, "channels.json");

// ─── Feed Sources ─────────────────────────────────────────────────────────────
const FEEDS = {
  pc: [
    {
      url: "https://store.steampowered.com/feeds/news/app/578080",
      keywords: ["update", "patch", "hotfix", "maintenance", "season", "event", "fix", "preview", "notice"],
    },
  ],
  mobile: [
    // Official PUBG Mobile Google News RSS
    { url: "https://news.google.com/rss/search?q=PUBG+Mobile+update+OR+patch+OR+season&hl=en-US&gl=US&ceid=US:en", keywords: [] },
    // Reddit Official Posts
    { url: "https://www.reddit.com/r/PUBGMobile/search.rss?q=flair%3AOfficial&sort=new&restrict_sr=1", keywords: [] },
  ],
};

const GAME_META = {
  pc: {
    name: "PUBG PC",
    emoji: "🖥️",
    color: 0xf5a623,
    bannerColor: "#F5A623",
    icon: "https://cdn.cloudflare.steamstatic.com/steam/apps/578080/header.jpg",
    tag: "BATTLEGROUNDS",
  },
  mobile: {
    name: "PUBG Mobile",
    emoji: "📱",
    color: 0x00b4ff,
    bannerColor: "#00B4FF",
    icon: "https://play-lh.googleusercontent.com/JRd05pyBH41qjgsJuWduRJpDeZG0Hnb0yjf2nWqO7VaGKL10-G5UIygxED-WNdfHA=w480-h960",
    tag: "PUBG MOBILE",
  },
};

// ─── Data helpers ─────────────────────────────────────────────────────────────
function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadSentIds() {
  try { if (fs.existsSync(SENT_FILE)) return new Set(JSON.parse(fs.readFileSync(SENT_FILE, "utf8"))); } catch {}
  return new Set();
}
function saveSentIds() {
  fs.writeFileSync(SENT_FILE, JSON.stringify([...sentIds].slice(-800)), "utf8");
}

// channels.json → { guildId: { pc: "channelId", mobile: "channelId" } }
function loadChannels() {
  try { if (fs.existsSync(CHANNELS_FILE)) return JSON.parse(fs.readFileSync(CHANNELS_FILE, "utf8")); } catch {}
  return {};
}
function saveChannels() {
  fs.writeFileSync(CHANNELS_FILE, JSON.stringify(guildChannels, null, 2), "utf8");
}

// ─── State ────────────────────────────────────────────────────────────────────
ensureDataDir();
let sentIds = loadSentIds();
let guildChannels = loadChannels();

const parser = new Parser({
  headers: { "User-Agent": "Mozilla/5.0 PUBG-Discord-Bot/2.0" },
  customFields: { item: [["media:thumbnail", "mediaThumbnail"], ["media:content", "mediaContent"]] },
});

// ─── Permission Check ─────────────────────────────────────────────────────────
function hasSetChannelPermission(interaction) {
  const isOwner = interaction.guild.ownerId === interaction.user.id;
  const isAdmin = interaction.member.permissions.has(PermissionFlagsBits.Administrator);
  const isAllowed = ALLOWED_USER_IDS.includes(interaction.user.id);
  return isOwner || isAdmin || isAllowed;
}

// ─── Discord Client ───────────────────────────────────────────────────────────
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once("ready", async () => {
  console.log(`\n╔════════════════════════════════╗`);
  console.log(`║   PUBG Update Bot — Online ✅   ║`);
  console.log(`║   ${client.user.tag.padEnd(30)}║`);
  console.log(`╚════════════════════════════════╝\n`);
  await registerCommands();
  checkAllFeeds();
  setInterval(checkAllFeeds, CHECK_INTERVAL_MINUTES * 60 * 1000);
});

// ─── Feed Checker ─────────────────────────────────────────────────────────────
async function checkAllFeeds(specificGuildId = null) {
  console.log(`\n🔍 [${new Date().toLocaleTimeString()}] Checking feeds...`);

  for (const gameKey of ["pc", "mobile"]) {
    const items = await fetchAllItems(gameKey);

    for (const item of items) {
      const id = item.guid || item.link || item.title;
      if (!id || sentIds.has(id)) continue;
      sentIds.add(id);

      // Determine which guilds/channels to send to
      const targets = specificGuildId ? [specificGuildId] : Object.keys(guildChannels);
      for (const guildId of targets) {
        const cfg = guildChannels[guildId];
        if (!cfg) continue;
        const channelId = cfg[gameKey] || cfg.both;
        if (!channelId) continue;
        const ch = await client.channels.fetch(channelId).catch(() => null);
        if (ch) await sendGameEmbed(ch, gameKey, item);
        await sleep(1200);
      }
    }
  }

  saveSentIds();
}

async function fetchAllItems(gameKey) {
  const allItems = [];
  for (const src of FEEDS[gameKey]) {
    try {
      const result = await parser.parseURL(src.url);
      let items = result.items.slice(0, 8).reverse();

      if (src.keywords && src.keywords.length > 0) {
        items = items.filter((item) => {
          const text = (item.title + " " + (item.contentSnippet || "")).toLowerCase();
          return src.keywords.some((kw) => text.includes(kw));
        });
      }
      allItems.push(...items);
    } catch (err) {
      console.error(`❌ Feed error [${gameKey}]: ${err.message}`);
    }
  }
  return allItems;
}

// ─── Beautiful Embed Builder ───────────────────────────────────────────────────
async function sendGameEmbed(channel, gameKey, item) {
  const meta = GAME_META[gameKey];
  const title = item.title || "New Update";
  const link = item.link || "";
  const pubDate = item.pubDate ? new Date(item.pubDate) : new Date();
  const snippet = item.contentSnippet
    ? item.contentSnippet.replace(/\n+/g, " ").slice(0, 280) + "..."
    : null;

  // Extract image
  const imgUrl =
    item.mediaThumbnail?.$?.url ||
    item.mediaContent?.$?.url ||
    extractImage(item["content:encoded"] || item.content || "");

  // ── Main Embed ──────────────────────────────────────────────────────────────
  const embed = new EmbedBuilder()
    .setColor(meta.color)
    .setAuthor({
      name: `${meta.tag}  •  NEW UPDATE`,
      iconURL: meta.icon,
    })
    .setTitle(`${meta.emoji}  ${title}`)
    .setURL(link)
    .setTimestamp(pubDate)
    .setFooter({
      text: `PUBG Update Bot  •  ${meta.name}`,
      iconURL: "https://cdn.cloudflare.steamstatic.com/steam/apps/578080/capsule_sm_120.jpg",
    });

  if (snippet) {
    embed.setDescription(
      `> ${snippet}\n\n` +
      `🔗 **[Full Update parhne ke liye click karo](${link})**`
    );
  } else {
    embed.setDescription(`🔗 **[Full Update parhne ke liye click karo](${link})**`);
  }

  if (imgUrl) embed.setImage(imgUrl);

  embed.addFields({
    name: "📅 Release Date",
    value: `<t:${Math.floor(pubDate.getTime() / 1000)}:F>`,
    inline: false,
  });

  // ── Button Row ──────────────────────────────────────────────────────────────
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel("🔗 Full Update Dekho")
      .setURL(link || "https://pubg.com")
      .setStyle(ButtonStyle.Link),
    new ButtonBuilder()
      .setLabel(gameKey === "pc" ? "🖥️ Steam Page" : "📱 PUBG Mobile")
      .setURL(
        gameKey === "pc"
          ? "https://store.steampowered.com/app/578080"
          : "https://www.pubgmobile.com/en-US/news/"
      )
      .setStyle(ButtonStyle.Link)
  );

  await channel.send({
    content: `@everyone  ${meta.emoji} **${meta.name}** mein naya update aaya hai! 🎮`,
    embeds: [embed],
    components: [row],
  });

  console.log(`📨 [${meta.name}] ${title}`);
}

function extractImage(html) {
  const m = html.match(/<img[^>]+src=["']([^"']+)["']/i);
  return m ? m[1] : null;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ─── Slash Commands ───────────────────────────────────────────────────────────
const commands = [
  new SlashCommandBuilder()
    .setName("pubg")
    .setDescription("PUBG Update Bot commands")

    // /pubg setchannel — dono ke liye ek channel
    .addSubcommand((sub) =>
      sub
        .setName("setchannel")
        .setDescription("🎮 PUBG PC + Mobile dono updates is channel mein aayenge")
        .addChannelOption((opt) =>
          opt.setName("channel").setDescription("Channel (khali = current)").setRequired(false)
        )
    )
    // /pubg setpchannel — sirf PC
    .addSubcommand((sub) =>
      sub
        .setName("setpchannel")
        .setDescription("🖥️ Sirf PUBG PC updates is channel mein aayenge")
        .addChannelOption((opt) =>
          opt.setName("channel").setDescription("Channel (khali = current)").setRequired(false)
        )
    )
    // /pubg setmobilechannel — sirf Mobile
    .addSubcommand((sub) =>
      sub
        .setName("setmobilechannel")
        .setDescription("📱 Sirf PUBG Mobile updates is channel mein aayenge")
        .addChannelOption((opt) =>
          opt.setName("channel").setDescription("Channel (khali = current)").setRequired(false)
        )
    )
    // /pubg removechannel
    .addSubcommand((sub) =>
      sub
        .setName("removechannel")
        .setDescription("🔕 Is server se saari PUBG updates band karo")
        .addStringOption((opt) =>
          opt
            .setName("game")
            .setDescription("Kaunsi updates band karni hain?")
            .addChoices(
              { name: "🖥️ PUBG PC only", value: "pc" },
              { name: "📱 PUBG Mobile only", value: "mobile" },
              { name: "🎮 Dono band karo", value: "both" }
            )
            .setRequired(false)
        )
    )
    // /pubg status
    .addSubcommand((sub) =>
      sub.setName("status").setDescription("📊 Current channel settings dekho")
    )
    // /pubg lastupdate
    .addSubcommand((sub) =>
      sub
        .setName("lastupdate")
        .setDescription("📰 Latest update abhi dikhao")
        .addStringOption((opt) =>
          opt
            .setName("game")
            .setDescription("Kaunsa game?")
            .addChoices(
              { name: "🖥️ PUBG PC", value: "pc" },
              { name: "📱 PUBG Mobile", value: "mobile" },
              { name: "🎮 Dono", value: "both" }
            )
        )
    )
    // /pubg check
    .addSubcommand((sub) =>
      sub.setName("check").setDescription("🔍 Manually updates check karo abhi")
    ),
];

async function registerCommands() {
  const rest = new REST().setToken(TOKEN);
  try {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands.map((c) => c.toJSON()) });
    console.log("✅ Slash commands registered!");
  } catch (err) {
    console.error("❌ Commands error:", err.message);
  }
}

// ─── Helper: Set a game channel ───────────────────────────────────────────────
async function handleSetChannel(interaction, gameKey) {
  if (!hasSetChannelPermission(interaction)) {
    return interaction.reply({
      content: "❌ Ye command sirf **Server Owner**, **Admin** ya allowed users use kar sakte hain.",
      ephemeral: true,
    });
  }

  const targetChannel = interaction.options.getChannel("channel") || interaction.channel;
  const botPerms = targetChannel.permissionsFor(interaction.guild.members.me);

  if (!botPerms?.has(PermissionFlagsBits.SendMessages) || !botPerms?.has(PermissionFlagsBits.EmbedLinks)) {
    return interaction.reply({
      content: `❌ Bot ko **${targetChannel}** mein \`Send Messages\` aur \`Embed Links\` permission chahiye!`,
      ephemeral: true,
    });
  }

  if (!guildChannels[interaction.guildId]) guildChannels[interaction.guildId] = {};

  if (gameKey === "both") {
    guildChannels[interaction.guildId].both = targetChannel.id;
    delete guildChannels[interaction.guildId].pc;
    delete guildChannels[interaction.guildId].mobile;
  } else {
    guildChannels[interaction.guildId][gameKey] = targetChannel.id;
    delete guildChannels[interaction.guildId].both;
  }

  saveChannels();

  const gameLabel =
    gameKey === "both"
      ? "🖥️ PUBG PC + 📱 PUBG Mobile"
      : gameKey === "pc"
      ? "🖥️ PUBG PC"
      : "📱 PUBG Mobile";

  const embed = new EmbedBuilder()
    .setColor(gameKey === "mobile" ? 0x00b4ff : gameKey === "pc" ? 0xf5a623 : 0x57f287)
    .setTitle("✅ Channel Set Ho Gaya!")
    .setDescription(
      `${targetChannel} mein **${gameLabel}** updates aate rahenge!\n\n` +
      `⏰ Har **${CHECK_INTERVAL_MINUTES} minutes** mein auto check hoga.\n` +
      `📊 Status dekhne ke liye \`/pubg status\` use karo.`
    )
    .addFields(
      { name: "📢 Channel", value: `${targetChannel}`, inline: true },
      { name: "🎮 Game", value: gameLabel, inline: true }
    )
    .setTimestamp()
    .setFooter({ text: "PUBG Update Bot" });

  await interaction.reply({ embeds: [embed] });

  // Confirmation in target channel if different
  if (targetChannel.id !== interaction.channelId) {
    const confirmEmbed = new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle("🎮 PUBG Update Bot Active!")
      .setDescription(`Is channel mein **${gameLabel}** updates aate rahenge!`)
      .setTimestamp();
    await targetChannel.send({ embeds: [confirmEmbed] }).catch(() => {});
  }
}

// ─── Interaction Handler ──────────────────────────────────────────────────────
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== "pubg") return;

  const sub = interaction.options.getSubcommand();

  if (sub === "setchannel") return handleSetChannel(interaction, "both");
  if (sub === "setpchannel") return handleSetChannel(interaction, "pc");
  if (sub === "setmobilechannel") return handleSetChannel(interaction, "mobile");

  // ── /pubg removechannel ───────────────────────────────────────────────────
  if (sub === "removechannel") {
    if (!hasSetChannelPermission(interaction)) {
      return interaction.reply({ content: "❌ Permission nahi hai.", ephemeral: true });
    }
    if (!guildChannels[interaction.guildId]) {
      return interaction.reply({ content: "⚠️ Koi channel set nahi tha.", ephemeral: true });
    }
    const game = interaction.options.getString("game") || "both";
    if (game === "both") {
      delete guildChannels[interaction.guildId];
    } else {
      delete guildChannels[interaction.guildId]?.[game];
      delete guildChannels[interaction.guildId]?.both;
    }
    saveChannels();
    return interaction.reply({ content: `🔕 Updates band ho gaye. Dobara ke liye \`/pubg setchannel\` use karo.` });
  }

  // ── /pubg status ──────────────────────────────────────────────────────────
  if (sub === "status") {
    const cfg = guildChannels[interaction.guildId];
    if (!cfg) {
      return interaction.reply({ content: "⚠️ Koi channel set nahi. `/pubg setchannel` se set karo.", ephemeral: true });
    }

    const getChMention = async (id) => {
      if (!id) return "❌ Set nahi";
      const ch = await client.channels.fetch(id).catch(() => null);
      return ch ? `<#${id}>` : "❌ Channel delete ho gayi";
    };

    let pcCh, mobileCh;
    if (cfg.both) {
      pcCh = await getChMention(cfg.both);
      mobileCh = pcCh + " *(same)*";
    } else {
      pcCh = await getChMention(cfg.pc);
      mobileCh = await getChMention(cfg.mobile);
    }

    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle("📊 PUBG Bot — Server Status")
      .addFields(
        { name: "🖥️ PUBG PC Channel", value: pcCh, inline: false },
        { name: "📱 PUBG Mobile Channel", value: mobileCh, inline: false },
        { name: "⏰ Check Interval", value: `Har ${CHECK_INTERVAL_MINUTES} minutes`, inline: true },
        { name: "🎮 Games", value: "PUBG PC + PUBG Mobile", inline: true }
      )
      .setTimestamp()
      .setFooter({ text: "PUBG Update Bot" });

    return interaction.reply({ embeds: [embed], ephemeral: true });
  }

  // ── /pubg check ───────────────────────────────────────────────────────────
  if (sub === "check") {
    if (!hasSetChannelPermission(interaction)) {
      return interaction.reply({ content: "❌ Sirf admins manual check kar sakte hain.", ephemeral: true });
    }
    await interaction.reply({ content: "🔍 Updates check ho rahe hain...", ephemeral: true });
    await checkAllFeeds(interaction.guildId);
    return interaction.editReply({ content: "✅ Done! Naye updates mile toh channel mein send kar diye." });
  }

  // ── /pubg lastupdate ──────────────────────────────────────────────────────
  if (sub === "lastupdate") {
    await interaction.deferReply();
    const game = interaction.options.getString("game") || "both";
    const keys = game === "both" ? ["pc", "mobile"] : [game];
    let sent = false;

    for (const key of keys) {
      const items = await fetchAllItems(key);
      const latest = items[items.length - 1];
      if (!latest) continue;

      const meta = GAME_META[key];
      const pubDate = latest.pubDate ? new Date(latest.pubDate) : new Date();
      const snippet = latest.contentSnippet?.replace(/\n+/g, " ").slice(0, 280);

      const embed = new EmbedBuilder()
        .setColor(meta.color)
        .setAuthor({ name: `${meta.tag}  •  LATEST UPDATE`, iconURL: meta.icon })
        .setTitle(`${meta.emoji}  ${latest.title || "Update"}`)
        .setURL(latest.link || "")
        .setDescription(
          (snippet ? `> ${snippet}...\n\n` : "") +
          `🔗 **[Full Update parhne ke liye click karo](${latest.link || ""})**`
        )
        .addFields({
          name: "📅 Date",
          value: `<t:${Math.floor(pubDate.getTime() / 1000)}:F>`,
          inline: false,
        })
        .setTimestamp(pubDate)
        .setFooter({ text: `PUBG Update Bot  •  ${meta.name}` });

      const imgUrl =
        latest.mediaThumbnail?.$?.url ||
        extractImage(latest["content:encoded"] || latest.content || "");
      if (imgUrl) embed.setImage(imgUrl);

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel("🔗 Full Update").setURL(latest.link || "https://pubg.com").setStyle(ButtonStyle.Link)
      );

      await interaction.followUp({ embeds: [embed], components: [row] });
      sent = true;
    }

    if (!sent) await interaction.followUp({ content: "❌ Update fetch nahi hua. Thodi der baad try karo." });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
if (!TOKEN || !CLIENT_ID) {
  console.error("❌ DISCORD_TOKEN ya CLIENT_ID missing! .env check karo.");
  process.exit(1);
}
client.login(TOKEN);
