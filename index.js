const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  SlashCommandBuilder,
  PermissionFlagsBits,
  REST,
  Routes,
} = require("discord.js");
const Parser = require("rss-parser");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

// ─── Config ───────────────────────────────────────────────────────────────────
const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const CHECK_INTERVAL_MINUTES = parseInt(process.env.CHECK_INTERVAL_MINUTES) || 30;

const DATA_DIR = path.join(__dirname, "data");
const SENT_FILE = path.join(DATA_DIR, "sent_updates.json");
const CHANNELS_FILE = path.join(DATA_DIR, "channels.json");

const FEEDS = [
  {
    name: "PUBG PC",
    url: "https://store.steampowered.com/feeds/news/app/578080",
    color: 0xf5a623,
    emoji: "🖥️",
    thumbnail: "https://cdn.cloudflare.steamstatic.com/steam/apps/578080/header.jpg",
    keywords: ["update", "patch", "hotfix", "maintenance", "season", "event", "fix", "battlegrounds"],
  },
  {
    name: "PUBG Mobile",
    url: "https://www.pubgmobile.com/en-US/news/rss.shtml",
    color: 0x00c2ff,
    emoji: "📱",
    thumbnail: "https://static.wikia.nocookie.net/pubg_gamepedia/images/thumb/8/89/PUBG_Mobile_Logo.png/600px-PUBG_Mobile_Logo.png",
    keywords: [],
  },
];

// ─── Data Helpers ─────────────────────────────────────────────────────────────
function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadSentIds() {
  try {
    if (fs.existsSync(SENT_FILE))
      return new Set(JSON.parse(fs.readFileSync(SENT_FILE, "utf8")));
  } catch {}
  return new Set();
}

function saveSentIds() {
  const arr = [...sentIds].slice(-500);
  fs.writeFileSync(SENT_FILE, JSON.stringify(arr), "utf8");
}

function loadChannels() {
  try {
    if (fs.existsSync(CHANNELS_FILE))
      return JSON.parse(fs.readFileSync(CHANNELS_FILE, "utf8"));
  } catch {}
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
  customFields: { item: [["media:thumbnail", "mediaThumbnail"]] },
});

// ─── Discord Client ───────────────────────────────────────────────────────────
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once("ready", async () => {
  console.log(`✅ Bot online: ${client.user.tag}`);
  console.log(`📡 Check interval: ${CHECK_INTERVAL_MINUTES} minutes`);
  await registerCommands();
  checkAllFeeds();
  setInterval(checkAllFeeds, CHECK_INTERVAL_MINUTES * 60 * 1000);
});

// ─── Feed Logic ───────────────────────────────────────────────────────────────
async function checkAllFeeds(specificGuildId = null) {
  console.log(`\n🔍 [${new Date().toLocaleTimeString()}] Checking feeds...`);

  const targets = specificGuildId
    ? (guildChannels[specificGuildId] ? { [specificGuildId]: guildChannels[specificGuildId] } : {})
    : guildChannels;

  if (Object.keys(targets).length === 0) {
    console.log("⚠️  Koi channel set nahi. /pubg setchannel use karo.");
    return;
  }

  for (const feed of FEEDS) {
    const items = await fetchFeedItems(feed);
    for (const item of items) {
      const id = item.guid || item.link || item.title;
      if (!id || sentIds.has(id)) continue;

      if (feed.keywords.length > 0) {
        const text = (item.title + " " + (item.contentSnippet || "")).toLowerCase();
        if (!feed.keywords.some((kw) => text.includes(kw))) {
          sentIds.add(id);
          continue;
        }
      }

      for (const [, channelId] of Object.entries(targets)) {
        const ch = await client.channels.fetch(channelId).catch(() => null);
        if (ch) {
          await sendEmbed(ch, feed, item);
          await sleep(1000);
        }
      }

      sentIds.add(id);
    }
  }

  saveSentIds();
}

async function fetchFeedItems(feed) {
  try {
    const result = await parser.parseURL(feed.url);
    return result.items.slice(0, 10).reverse();
  } catch (err) {
    console.error(`❌ [${feed.name}] ${err.message}`);
    return [];
  }
}

async function sendEmbed(channel, feed, item) {
  const title = item.title || "New Update";
  const snippet = item.contentSnippet
    ? item.contentSnippet.slice(0, 350) + (item.contentSnippet.length > 350 ? "..." : "")
    : "";

  const embed = new EmbedBuilder()
    .setColor(feed.color)
    .setAuthor({ name: `${feed.emoji} ${feed.name} — Naya Update!`, iconURL: feed.thumbnail })
    .setTitle(title)
    .setURL(item.link || "")
    .setTimestamp(item.pubDate ? new Date(item.pubDate) : new Date())
    .setFooter({ text: "PUBG Update Bot • Auto Notification" });

  if (snippet) embed.setDescription(snippet);

  const imgUrl =
    item.mediaThumbnail?.$?.url ||
    (item["content:encoded"] || item.content || "").match(/<img[^>]+src=["']([^"']+)["']/i)?.[1];
  if (imgUrl) embed.setImage(imgUrl);

  await channel.send({
    content: `@everyone ${feed.emoji} **${feed.name}** mein naya update aaya hai!`,
    embeds: [embed],
  });

  console.log(`📨 [${feed.name}] ${title}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Slash Commands ───────────────────────────────────────────────────────────
const commands = [
  new SlashCommandBuilder()
    .setName("pubg")
    .setDescription("PUBG Update Bot commands")
    .addSubcommand((sub) =>
      sub
        .setName("setchannel")
        .setDescription("✅ Is channel mein PUBG updates aane lagenge")
        .addChannelOption((opt) =>
          opt
            .setName("channel")
            .setDescription("Channel choose karo (khali chodo = current channel)")
            .setRequired(false)
        )
    )
    .addSubcommand((sub) =>
      sub.setName("removechannel").setDescription("🔕 Is server se PUBG updates band karo")
    )
    .addSubcommand((sub) =>
      sub.setName("status").setDescription("📊 Dekho kaunse channel mein updates aa rahe hain")
    )
    .addSubcommand((sub) =>
      sub
        .setName("lastupdate")
        .setDescription("📰 Latest PUBG update abhi dikhao")
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
    .addSubcommand((sub) =>
      sub.setName("check").setDescription("🔍 Abhi manually updates check karo")
    ),
];

async function registerCommands() {
  const rest = new REST().setToken(TOKEN);
  try {
    await rest.put(Routes.applicationCommands(CLIENT_ID), {
      body: commands.map((c) => c.toJSON()),
    });
    console.log("✅ Slash commands registered!");
  } catch (err) {
    console.error("❌ Commands error:", err.message);
  }
}

// ─── Interaction Handler ──────────────────────────────────────────────────────
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== "pubg") return;

  const sub = interaction.options.getSubcommand();

  // ── /pubg setchannel ──────────────────────────────────────────────────────
  if (sub === "setchannel") {
    if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({
        content: "❌ Tumhare paas **Manage Server** permission nahi hai.",
        ephemeral: true,
      });
    }

    const targetChannel = interaction.options.getChannel("channel") || interaction.channel;

    const botPerms = targetChannel.permissionsFor(interaction.guild.members.me);
    if (!botPerms?.has(PermissionFlagsBits.SendMessages) || !botPerms?.has(PermissionFlagsBits.EmbedLinks)) {
      return interaction.reply({
        content:
          `❌ Bot ko **${targetChannel}** mein message bhejne ki permission nahi hai!\n` +
          `Bot ko \`Send Messages\` aur \`Embed Links\` permission do.`,
        ephemeral: true,
      });
    }

    guildChannels[interaction.guildId] = targetChannel.id;
    saveChannels();

    const embed = new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle("✅ PUBG Update Channel Set Ho Gaya!")
      .setDescription(
        `Ab ${targetChannel} mein PUBG updates aate rahenge!\n\n` +
          `🖥️ **PUBG PC** — Steam patches, hotfixes, seasonal events\n` +
          `📱 **PUBG Mobile** — Official news aur updates\n\n` +
          `⏰ Har **${CHECK_INTERVAL_MINUTES} minutes** mein automatically check hoga.`
      )
      .addFields(
        { name: "📢 Channel", value: `${targetChannel}`, inline: true },
        { name: "⏰ Interval", value: `${CHECK_INTERVAL_MINUTES} min`, inline: true }
      )
      .setFooter({ text: "Band karne ke liye /pubg removechannel | Status: /pubg status" })
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });

    // Confirmation in target channel (if different)
    if (targetChannel.id !== interaction.channelId) {
      const confirmEmbed = new EmbedBuilder()
        .setColor(0x57f287)
        .setTitle("🎮 PUBG Update Bot Active!")
        .setDescription(
          "Is channel mein PUBG PC aur PUBG Mobile ke updates aate rahenge!\n" +
            "Koi aur channel set karna ho toh `/pubg setchannel` use karo."
        )
        .setTimestamp();
      await targetChannel.send({ embeds: [confirmEmbed] }).catch(() => {});
    }

    return;
  }

  // ── /pubg removechannel ───────────────────────────────────────────────────
  if (sub === "removechannel") {
    if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({ content: "❌ Tumhare paas **Manage Server** permission nahi hai.", ephemeral: true });
    }
    if (!guildChannels[interaction.guildId]) {
      return interaction.reply({ content: "⚠️ Is server mein koi channel set nahi tha.", ephemeral: true });
    }
    delete guildChannels[interaction.guildId];
    saveChannels();
    return interaction.reply({
      content: "🔕 PUBG updates band ho gaye. Dobara ke liye `/pubg setchannel` use karo.",
    });
  }

  // ── /pubg status ──────────────────────────────────────────────────────────
  if (sub === "status") {
    const channelId = guildChannels[interaction.guildId];
    if (!channelId) {
      return interaction.reply({
        content: "⚠️ Koi channel set nahi. `/pubg setchannel` se set karo.",
        ephemeral: true,
      });
    }
    const ch = await client.channels.fetch(channelId).catch(() => null);
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle("📊 PUBG Bot Status")
      .addFields(
        { name: "📢 Update Channel", value: ch ? `<#${channelId}>` : "❌ Channel delete ho gayi?", inline: false },
        { name: "⏰ Check Interval", value: `Har ${CHECK_INTERVAL_MINUTES} minutes`, inline: true },
        { name: "🎮 Games", value: "PUBG PC + PUBG Mobile", inline: true }
      )
      .setTimestamp();
    return interaction.reply({ embeds: [embed], ephemeral: true });
  }

  // ── /pubg check ───────────────────────────────────────────────────────────
  if (sub === "check") {
    if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({ content: "❌ Sirf admins manual check kar sakte hain.", ephemeral: true });
    }
    await interaction.reply({ content: "🔍 Updates check ho rahe hain...", ephemeral: true });
    await checkAllFeeds(interaction.guildId);
    return interaction.editReply({ content: "✅ Check complete! Naye updates mile toh channel mein bhej diye." });
  }

  // ── /pubg lastupdate ──────────────────────────────────────────────────────
  if (sub === "lastupdate") {
    await interaction.deferReply();
    const game = interaction.options.getString("game") || "both";

    const feedsToCheck = FEEDS.filter((f) => {
      if (game === "both") return true;
      if (game === "pc") return f.name.includes("PC");
      if (game === "mobile") return f.name.includes("Mobile");
      return true;
    });

    let sent = false;
    for (const feed of feedsToCheck) {
      const items = await fetchFeedItems(feed);
      const latest = items[items.length - 1];
      if (!latest) continue;

      const embed = new EmbedBuilder()
        .setColor(feed.color)
        .setAuthor({ name: `${feed.emoji} ${feed.name} — Latest Update`, iconURL: feed.thumbnail })
        .setTitle(latest.title || "Update")
        .setURL(latest.link || "")
        .setDescription(
          latest.contentSnippet ? latest.contentSnippet.slice(0, 400) + "..." : "Link click karo."
        )
        .setTimestamp(latest.pubDate ? new Date(latest.pubDate) : new Date())
        .setFooter({ text: "PUBG Update Bot" });

      const imgUrl =
        latest.mediaThumbnail?.$?.url ||
        (latest["content:encoded"] || latest.content || "").match(/<img[^>]+src=["']([^"']+)["']/i)?.[1];
      if (imgUrl) embed.setImage(imgUrl);

      await interaction.followUp({ embeds: [embed] });
      sent = true;
    }

    if (!sent) {
      await interaction.followUp({ content: "❌ Update fetch nahi hua. Thodi der baad try karo." });
    }
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
if (!TOKEN || !CLIENT_ID) {
  console.error("❌ DISCORD_TOKEN ya CLIENT_ID missing! .env check karo.");
  process.exit(1);
}
client.login(TOKEN);
