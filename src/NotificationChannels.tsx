import {
  isPreferenceEnabled, NOTIFICATION_CHANNEL_COLUMNS, notificationEventsForRole, preferenceKey, type NotificationPreferenceMatrix
} from "./notification-channels.js";

/**
 * Таблица «событие × канал» с галочками: какие уведомления сотрудник получает на почту, какие в Telegram.
 * Показывает только события, которые приходят его роли. Сохраняет родитель вместе с остальной формой.
 */
export function NotificationChannelsField({
  disabled,
  matrix,
  onChange,
  role,
  telegramLinked
}: {
  readonly disabled?: boolean;
  readonly matrix: NotificationPreferenceMatrix;
  readonly onChange: (next: NotificationPreferenceMatrix) => void;
  readonly role: string | undefined;
  readonly telegramLinked: boolean;
}) {
  const events = notificationEventsForRole(role);
  return (
    <fieldset className="field-wide notify-channels" disabled={disabled}>
      <legend>Какие уведомления получать</legend>
      <div className="table-scroll">
        <table className="notify-channels__table">
          <thead>
            <tr>
              <th scope="col">Событие</th>
              {NOTIFICATION_CHANNEL_COLUMNS.map((channel) => <th key={channel.code} scope="col">{channel.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {events.map((event) => (
              <tr key={event.code}>
                <th scope="row"><strong>{event.label}</strong><small>{event.when}</small></th>
                {NOTIFICATION_CHANNEL_COLUMNS.map((channel) => (
                  <td key={channel.code}>
                    <input
                      aria-label={`${event.label}: ${channel.label}`}
                      checked={isPreferenceEnabled(matrix, event.code, channel.code)}
                      onChange={(change) => onChange({ ...matrix, [preferenceKey(event.code, channel.code)]: change.target.checked })}
                      type="checkbox"
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {telegramLinked ? null : <p className="profile-hint">Telegram не подключён: галочки в столбце Telegram начнут действовать, когда появится номер чата.</p>}
    </fieldset>
  );
}
