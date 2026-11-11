import {
  renderNotificationTemplate,
  type BusinessEvent
} from "./domain.js";
import {
  channelDeliveryIdempotencyKey,
  type ChannelDeliveryCommand,
  type EventDeliveryPlanner,
  type OutboxSqlExecutor
} from "./outbox.js";

function requiredText(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`PostgreSQL вернул некорректное поле плана e-mail ${key}`);
  }
  return value;
}

function optionalText(row: Record<string, unknown>, key: string): string | undefined {
  const value = row[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function variablesFromRow(row: Record<string, unknown>): Readonly<Record<string, unknown>> {
  const value = row.variables;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("PostgreSQL вернул некорректные переменные шаблона e-mail");
  }
  return value as Readonly<Record<string, unknown>>;
}

function allowedVariablesFromRow(row: Record<string, unknown>): readonly string[] {
  if (!Array.isArray(row.allowed_variables)
    || row.allowed_variables.some((item) => typeof item !== "string" || !item)) {
    throw new Error("PostgreSQL вернул некорректный список переменных шаблона e-mail");
  }
  return row.allowed_variables as readonly string[];
}

/** Планировщик скрывает адресатов, шаблон и URL карточки за интерфейсом outbox. */
export class PostgresEmailEventDeliveryPlanner implements EventDeliveryPlanner {
  private readonly publicAppUrl: string;

  public constructor(
    private readonly database: OutboxSqlExecutor,
    publicAppUrl: string
  ) {
    const parsed = new URL(publicAppUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("PUBLIC_APP_URL должен использовать http или https");
    }
    this.publicAppUrl = parsed.toString().replace(/\/$/u, "");
  }

  public async plan(event: BusinessEvent): Promise<readonly ChannelDeliveryCommand[]> {
    const result = await this.database.executeSql(
      `SELECT recipient_user_id::text, recipient_address, recipient_name,
              subject_template, body_template, allowed_variables,
              task_id::text, variables
         FROM public.load_email_event_plan($1::uuid)`,
      [String(event.id)]
    );
    // Неверный адрес (например, с пробелом) не пропускаем молча: доставка
    // попадёт в журнал с ошибкой smtp_invalid_address и не будет повторяться.
    return result.rows.map((row) => {
      const recipientAddress = requiredText(row, "recipient_address").trim();
      const recipientUserId = optionalText(row, "recipient_user_id");
      const taskId = requiredText(row, "task_id");
      const variables = {
        ...variablesFromRow(row),
        taskUrl: `${this.publicAppUrl}/tasks/${encodeURIComponent(taskId)}`
      };
      const rendered = renderNotificationTemplate({
        subjectTemplate: typeof row.subject_template === "string" ? row.subject_template : "",
        bodyTemplate: requiredText(row, "body_template"),
        allowedVariables: allowedVariablesFromRow(row)
      }, variables);
      return {
        idempotencyKey: channelDeliveryIdempotencyKey(
          event,
          "email",
          recipientUserId ?? recipientAddress.toLocaleLowerCase("en-US")
        ),
        eventCode: event.eventCode,
        ...(recipientUserId ? { recipientUserId } : {}),
        channel: "email" as const,
        recipientAddress,
        subject: rendered.subject,
        body: rendered.body,
        taskId
      };
    });
  }
}

export async function enqueueOverdueTaskEvents(
  database: OutboxSqlExecutor,
  now: Date
): Promise<number> {
  if (Number.isNaN(now.getTime())) throw new Error("Время проверки просрочки должно быть корректным");
  const result = await database.executeSql(
    "SELECT public.enqueue_overdue_task_events($1::timestamptz) AS inserted_count",
    [now.toISOString()]
  );
  return Number(result.rows[0]?.inserted_count ?? 0);
}
