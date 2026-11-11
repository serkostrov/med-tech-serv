import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { configuredDeliveryChannels, notificationChannelConfiguration } from "./channel-config.js";
import type { DeliveryChannel } from "./outbox.js";

const email: DeliveryChannel = { code: "email", deliver: async (command) => ({ providerMessageId: command.idempotencyKey }) };

describe("notification channel configuration", () => {
  it("keeps external channels disabled unless explicitly enabled", () => {
    const configuration = notificationChannelConfiguration({});
    assert.deepEqual(configuration.enabled, { email: true, telegram: false, max: false, sms: false });
    assert.deepEqual(configuredDeliveryChannels(configuration, [email]), [email]);
  });

  it("fails closed when a channel is enabled without an adapter", () => {
    const configuration = notificationChannelConfiguration({ TELEGRAM_NOTIFICATIONS_ENABLED: "true" });
    assert.throws(() => configuredDeliveryChannels(configuration, [email]), /telegram.*not configured/u);
    assert.throws(() => notificationChannelConfiguration({ SMS_NOTIFICATIONS_ENABLED: "yes" }), /true or false/u);
  });
});
