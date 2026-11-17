import { useEffect, useRef, useState, type FormEvent } from "react";
import { m2Api } from "./m2-api.js";
import { NotificationChannelsField } from "./NotificationChannels.js";
import { changedPreferences, preferenceMatrix, type NotificationPreferenceMatrix } from "./notification-channels.js";
import { Button, DialogForm, toast } from "./ui.js";

type ProfileState =
  | { readonly kind: "loading" }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "loaded"; readonly email?: string; readonly telegramChatId?: string; readonly role?: string };

/** Галочки каналов: что загрузили и что сейчас в форме. Не загрузились — блока нет, профиль работает. */
type ChannelsState = { readonly initial: NotificationPreferenceMatrix; readonly current: NotificationPreferenceMatrix } | null;

/**
 * «Мой профиль»: сотрудник сам вписывает номер личного чата Telegram, который бот присылает на /start,
 * и выбирает, какие уведомления получать на почту и в Telegram (ТЗ, блок 5).
 * Роль и почту меняет администратор, здесь они только для справки.
 */
export function ProfileDialog({
  open,
  onOpenChange,
  fullName,
  roleName
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly fullName: string;
  readonly roleName: string;
}) {
  const [profile, setProfile] = useState<ProfileState>({ kind: "loading" });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [channels, setChannels] = useState<ChannelsState>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    setProfile({ kind: "loading" });
    setChannels(null);
    setError(null);
    m2Api.myProfile()
      .then((loaded) => { if (!cancelled) setProfile({ kind: "loaded", ...loaded }); })
      .catch((loadError: unknown) => {
        if (!cancelled) setProfile({ kind: "failed", message: loadError instanceof Error ? loadError.message : "Не получилось загрузить профиль" });
      });
    m2Api.notificationPreferences()
      .then((rows) => { if (!cancelled) { const matrix = preferenceMatrix(rows); setChannels({ initial: matrix, current: matrix }); } })
      .catch(() => { if (!cancelled) setChannels(null); });
    return () => { cancelled = true; };
  }, [open, attempt]);

  // Пока профиль грузится, поле заблокировано и фокус уходит на «Отмена»: после загрузки ставим его в поле.
  useEffect(() => {
    if (profile.kind === "loaded") inputRef.current?.focus();
  }, [profile.kind]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // Пока номер не загрузился, пустое поле не значит «убрать»: не сохраняем, чтобы не стереть номер.
    if (profile.kind !== "loaded") return;
    const value = String(new FormData(event.currentTarget).get("telegramChatId") ?? "");
    // Номер не меняли — его не трогаем, чтобы не затереть номер, который за это время вписал администратор.
    // Сравниваем до проверки: номер группы, вписанный администратором, сотрудник сохранить не может, но и не трогает.
    const chatChanged = value.replace(/\s+/gu, "") !== (profile.telegramChatId ?? "");
    const changedChannels = channels ? changedPreferences(channels.initial, channels.current) : [];
    if (!chatChanged && changedChannels.length === 0) { onOpenChange(false); return; }
    setSaving(true);
    setError(null);
    try {
      if (changedChannels.length > 0) await m2Api.saveNotificationPreferences(undefined, changedChannels);
      if (chatChanged) {
        const saved = await m2Api.setMyTelegramChatId(value);
        toast.success(saved ? "Уведомления CRM будут приходить вам в Telegram" : "Уведомления в Telegram отключены", { title: saved ? "Номер чата сохранён" : "Номер чата убран" });
      } else {
        toast.success("Уведомления будут приходить так, как отмечено", { title: "Настройки уведомлений сохранены" });
      }
      onOpenChange(false);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Не получилось сохранить профиль");
    } finally {
      setSaving(false);
    }
  };

  const loaded = profile.kind === "loaded" ? profile : undefined;
  return (
    <DialogForm
      busy={saving}
      description="Номер чата Telegram и какие уведомления получать на почту и в Telegram."
      error={profile.kind === "failed" ? profile.message : error}
      onOpenChange={onOpenChange}
      onSubmit={submit}
      open={open}
      submitDisabled={profile.kind !== "loaded"}
      submitLabel="Сохранить"
      title="Мой профиль"
    >
      <dl className="profile-summary field-wide">
        <dt>Сотрудник</dt><dd>{fullName}</dd>
        <dt>Роль</dt><dd>{roleName}</dd>
        {loaded?.email ? <><dt>E-mail</dt><dd>{loaded.email}</dd></> : null}
      </dl>
      {profile.kind === "failed"
        ? <div className="field-wide profile-retry">
          <p className="profile-hint">Номер чата не загрузился, поэтому сохранять пока нельзя: иначе сохранённый номер мог бы стереться.</p>
          <Button onClick={() => setAttempt((value) => value + 1)} variant="secondary">Повторить</Button>
        </div>
        : <label className="field-wide">Telegram, номер чата
          <input
            autoComplete="off"
            defaultValue={loaded?.telegramChatId ?? ""}
            disabled={!loaded}
            inputMode="numeric"
            key={loaded ? "loaded" : "loading"}
            name="telegramChatId"
            placeholder={loaded ? "Например, 123456789" : "Загружаем…"}
            ref={inputRef}
          />
        </label>}
      {profile.kind === "failed" ? null : <p className="field-wide profile-hint">
        Откройте бота компании в Telegram и отправьте ему /start в личном чате: он пришлёт номер. Вставьте номер сюда и сохраните.
        Чтобы уведомления в Telegram не приходили, очистите поле.
      </p>}
      {loaded && channels ? <NotificationChannelsField
        matrix={channels.current}
        onChange={(current) => setChannels((state) => (state ? { ...state, current } : state))}
        role={loaded.role}
        telegramLinked={Boolean(loaded.telegramChatId)}
      /> : null}
    </DialogForm>
  );
}
