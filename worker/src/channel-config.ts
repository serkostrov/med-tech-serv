import type { NotificationChannelCode } from "./domain.js";
import type { DeliveryChannel } from "./outbox.js";

export interface NotificationChannelConfiguration {
  readonly enabled: Readonly<Record<NotificationChannelCode, boolean>>;
}

function flag(environment: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = environment[name]?.trim().toLocaleLowerCase("en-US");
  if (!raw) return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`${name} must be true or false`);
}

/**
 * Конфигурация не содержит адресов и токенов провайдеров: секреты принадлежат
 * конкретным адаптерам и читаются ими только при явно включённом канале.
 */
export function notificationChannelConfiguration(environment: NodeJS.ProcessEnv): NotificationChannelConfiguration {
  return {
    enabled: {
      email: flag(environment, "EMAIL_NOTIFICATIONS_ENABLED", true),
      telegram: flag(environment, "TELEGRAM_NOTIFICATIONS_ENABLED", false),
      max: flag(environment, "MAX_NOTIFICATIONS_ENABLED", false),
      sms: flag(environment, "SMS_NOTIFICATIONS_ENABLED", false)
    }
  };
}

/** Не позволяет включить канал без установленного production-адаптера. */
export function configuredDeliveryChannels(configuration: NotificationChannelConfiguration, adapters: readonly DeliveryChannel[]): readonly DeliveryChannel[] {
  const byCode = new Map(adapters.map((adapter) => [adapter.code, adapter]));
  for (const [code, enabled] of Object.entries(configuration.enabled) as Array<[NotificationChannelCode, boolean]>) {
    if (enabled && !byCode.has(code)) throw new Error(`Notification channel ${code} is enabled but its delivery adapter is not configured`);
  }
  return adapters.filter((adapter) => configuration.enabled[adapter.code]);
}
