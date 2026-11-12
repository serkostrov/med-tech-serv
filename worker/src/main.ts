import { rm, writeFile } from "node:fs/promises";
import pg from "pg";
import { configuredDeliveryChannels, notificationChannelConfiguration } from "./channel-config.js";
import { PostgresEmailEventDeliveryPlanner } from "./email-planner.js";
import { maintenanceActivationConfig } from "./maintenance-activation.js";
import { PostgresEventOutboxRepository, type DeliveryChannel, type EventDeliveryPlanner, type OutboxSqlExecutor } from "./outbox.js";
import { CompositeEventDeliveryPlanner, DryRunDeliveryChannel, runPollCycle } from "./runtime.js";
import { NodeSmtpTransport, SmtpDeliveryChannel, smtpConfiguration } from "./smtp.js";
import { aiMailParserFromEnv } from "./ai-parser.js";
import { sendMailAutoreplies, type AutoreplySender } from "./mail-autoreply.js";
import { ImapMailIntake, imapSettings } from "./mail-intake.js";
import { supabaseMailFileStore } from "./storage-upload.js";
import {
  PostgresTelegramEventDeliveryPlanner,
  TelegramChatIdResponder,
  TelegramClient,
  TelegramDeliveryChannel,
  telegramConfiguration
} from "./telegram.js";

function flag(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`${name} must be true or false`);
}

function interval(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? String(fallback), 10);
  if (!Number.isInteger(value) || value < 1_000) throw new Error(`${name} must be at least 1000 milliseconds`);
  return value;
}

const connectionString = process.env.DATABASE_URL?.trim();
if (!connectionString) throw new Error("DATABASE_URL is required to start the worker");
const publicAppUrl = process.env.PUBLIC_APP_URL?.trim();
if (!publicAppUrl) throw new Error("PUBLIC_APP_URL is required to start the worker");

const dryRun = flag("NOTIFICATIONS_DRY_RUN", false);
// Пробный режим отмечает уведомления отправленными, ничего не отправляя.
// На стенде или в работе это «съело» бы очередь, поэтому только локально.
const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]", "::1"];
function databaseHost(url: string): string {
  try { return new URL(url).hostname; } catch { return ""; }
}
if (dryRun && (!LOCAL_HOSTS.includes(new URL(publicAppUrl).hostname) || !LOCAL_HOSTS.includes(databaseHost(connectionString)))) {
  throw new Error("NOTIFICATIONS_DRY_RUN разрешён только с локальными PUBLIC_APP_URL и DATABASE_URL (localhost)");
}
const pollIntervalMs = interval("OUTBOX_POLL_INTERVAL_MS", 5_000);
const maintenanceIntervalMs = interval("MAINTENANCE_CHECK_INTERVAL_MS", 10 * 60_000);
const healthFile = process.env.WORKER_HEALTH_FILE?.trim() || "/tmp/medtech-worker-ready";
const maintenance = maintenanceActivationConfig(process.env);
const enabled = notificationChannelConfiguration(process.env).enabled;

/** Код ошибки без текста: текст может содержать адрес базы или параметры. */
function errorCode(error: unknown): string {
  const value = error as { code?: unknown; diagnosticCode?: unknown; name?: unknown } | undefined;
  if (typeof value?.diagnosticCode === "string") return value.diagnosticCode;
  if (typeof value?.code === "string") return value.code;
  return typeof value?.name === "string" ? value.name : "unknown";
}

const pool = new pg.Pool({ connectionString, max: 4 });
// Обрыв простаивающего соединения (рестарт базы, pgbouncer) не должен ронять службу.
pool.on("error", (error) => console.error(`Соединение с базой прервано: ${errorCode(error)}`));
process.on("unhandledRejection", (error) => console.error(`Необработанная ошибка: ${errorCode(error)}`));
const database: OutboxSqlExecutor = { executeSql: (text, values) => pool.query(text, values as unknown[]) };

const planners: EventDeliveryPlanner[] = [];
const adapters: DeliveryChannel[] = [];
let telegramResponder: TelegramChatIdResponder | undefined;

if (enabled.email) {
  planners.push(new PostgresEmailEventDeliveryPlanner(database, publicAppUrl));
  if (dryRun) {
    adapters.push(new DryRunDeliveryChannel("email"));
  } else {
    const smtp = smtpConfiguration(process.env);
    // По журналу сразу видно, куда уходят письма: на тестовый адрес или настоящим адресатам.
    console.log(smtp.testRedirectTo ? `Тестовый режим почты: все письма уходят на ${smtp.testRedirectTo}` : "Почта: письма уходят адресатам");
    adapters.push(new SmtpDeliveryChannel(smtp, new NodeSmtpTransport(smtp)));
  }
}
if (enabled.telegram) {
  planners.push(new PostgresTelegramEventDeliveryPlanner(database, publicAppUrl));
  if (dryRun) {
    adapters.push(new DryRunDeliveryChannel("telegram"));
  } else {
    const client = new TelegramClient(telegramConfiguration(process.env));
    adapters.push(new TelegramDeliveryChannel(client));
    if (flag("TELEGRAM_CHAT_ID_REPLIES", true)) telegramResponder = new TelegramChatIdResponder(client);
  }
}
const channels = configuredDeliveryChannels({ enabled }, adapters);

// Заявки из почты (Блок 4): забор писем, разбор, автоответ «заявка принята».
const mailIntakeEnabled = flag("MAIL_INTAKE_ENABLED", false);
const mailIntervalMs = interval("MAIL_POLL_INTERVAL_MS", 60_000);
let mailIntake: ImapMailIntake | undefined;
let autoreplySender: AutoreplySender | undefined;
if (mailIntakeEnabled) {
  const files = supabaseMailFileStore(process.env);
  if (!files) console.warn("SUPABASE_URL и SUPABASE_SERVICE_ROLE_KEY не заданы: вложения писем сохраняться не будут");
  mailIntake = new ImapMailIntake(imapSettings(process.env), database, files, aiMailParserFromEnv(process.env));
  if (flag("MAIL_AUTOREPLY_ENABLED", true)) {
    if (dryRun) {
      autoreplySender = { send: async (message) => console.log(`Пробный режим: автоответ на ${message.toAddress} не отправлен`) };
    } else {
      const smtp = smtpConfiguration(process.env);
      const transport = new NodeSmtpTransport(smtp);
      autoreplySender = { send: (message) => transport.send({ ...message, fromAddress: smtp.fromAddress, fromName: smtp.fromName }) };
    }
  }
}
const planner = new CompositeEventDeliveryPlanner(planners);
const repository = new PostgresEventOutboxRepository(database);

console.log(`Служба уведомлений запущена: каналы ${channels.map((item) => item.code).join(", ") || "нет"}${mailIntake ? ", заявки из почты" : ""}${dryRun ? ", пробный режим" : ""}`);

let running = false;
let stopping = false;
let lastMaintenanceAt = 0;

async function poll(): Promise<void> {
  if (running || stopping) return;
  running = true;
  try {
    // Время берём у базы: часы службы могут отставать или спешить.
    const clock = await pool.query<{ now: Date }>("SELECT now() AS now");
    const now = clock.rows[0]?.now instanceof Date ? clock.rows[0].now : new Date();
    const runMaintenance = now.getTime() - lastMaintenanceAt >= maintenanceIntervalMs;
    const result = await runPollCycle({ database, repository, planner, channels, maintenance, now, runMaintenance, shouldStop: () => stopping });
    if (runMaintenance) lastMaintenanceAt = now.getTime();
    else if (now.getTime() < lastMaintenanceAt) lastMaintenanceAt = now.getTime();
    const { dispatch } = result;
    if (dispatch.claimedEvents || result.overdueEvents || result.activatedMaintenanceTasks) {
      console.log(`События: ${dispatch.claimedEvents}, доставлено: ${dispatch.deliveredMessages}, ошибок: ${dispatch.failedMessages}, повтор: ${dispatch.retryEvents}, просрочек: ${result.overdueEvents}, ТО запущено: ${result.activatedMaintenanceTasks}`);
    }
    if (telegramResponder) await telegramResponder.poll().catch((error: unknown) => console.error(`Ответ бота на /start не отправлен: ${errorCode(error)}`));
    await writeFile(healthFile, "ready\n", "utf8");
  } catch (error) {
    // Текст ошибки может содержать адрес базы или параметры, поэтому печатаем только код.
    console.error(`Проход очереди уведомлений не выполнен: ${errorCode(error)}`);
  } finally {
    running = false;
  }
}

let mailRunning = false;
let replyRunning = false;

async function sendReplies(): Promise<void> {
  if (!autoreplySender || replyRunning || stopping) return;
  replyRunning = true;
  try {
    const replies = await sendMailAutoreplies(database, autoreplySender);
    if (replies.sent || replies.failed) console.log(`Автоответы: отправлено ${replies.sent}, ошибок ${replies.failed}`);
  } catch (error) {
    console.error(`Автоответы не отправлены: ${errorCode(error)}`);
  } finally {
    replyRunning = false;
  }
}

async function pollMail(): Promise<void> {
  if (!mailIntake || mailRunning || stopping) return;
  mailRunning = true;
  try {
    const result = await mailIntake.poll();
    if (result.created) console.log(`Письма: новых ${result.created}, разобрано ${result.parsed}, ошибок ${result.failed}`);
  } catch (error) {
    console.error(`Забор писем не выполнен: ${errorCode(error)}`);
  } finally {
    mailRunning = false;
  }
}

let timer: ReturnType<typeof setInterval> | undefined;
let mailTimer: ReturnType<typeof setInterval> | undefined;
let replyTimer: ReturnType<typeof setInterval> | undefined;

async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  if (timer) clearInterval(timer);
  if (mailTimer) clearInterval(mailTimer);
  if (replyTimer) clearInterval(replyTimer);
  // Новые попытки уже не начинаются; текущую ждём не дольше 25 секунд.
  // В Docker поставьте stop_grace_period не меньше 30 секунд.
  const stopBy = Date.now() + 25_000;
  while ((running || mailRunning || replyRunning) && Date.now() < stopBy) await new Promise((resolve) => setTimeout(resolve, 100));
  await pool.end().catch(() => undefined);
  await rm(healthFile, { force: true });
  process.exit(0);
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

await poll();
if (!stopping) timer = setInterval(() => void poll(), pollIntervalMs);
if (mailIntake && !stopping) {
  void pollMail();
  mailTimer = setInterval(() => void pollMail(), mailIntervalMs);
  // Автоответ после создания задачи координатором уходит через несколько секунд, независимо от забора писем.
  if (autoreplySender) replyTimer = setInterval(() => void sendReplies(), pollIntervalMs);
}
