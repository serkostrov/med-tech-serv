import { useEffect, useRef, useState, type FormEvent } from "react";
import { m2Api } from "./m2-api.js";
import { Button, DialogForm, toast } from "./ui.js";

type ProfileState =
  | { readonly kind: "loading" }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "loaded"; readonly email?: string; readonly telegramChatId?: string };

/**
 * «Мой профиль»: сотрудник сам вписывает номер личного чата Telegram, который бот присылает на /start.
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
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    setProfile({ kind: "loading" });
    setError(null);
    m2Api.myProfile()
      .then((loaded) => { if (!cancelled) setProfile({ kind: "loaded", ...loaded }); })
      .catch((loadError: unknown) => {
        if (!cancelled) setProfile({ kind: "failed", message: loadError instanceof Error ? loadError.message : "Не получилось загрузить профиль" });
      });
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
    // Номер не меняли: просто закрываем, чтобы не затереть номер, который за это время вписал администратор.
    // Сравниваем до проверки: номер группы, вписанный администратором, сотрудник сохранить не может, но и не трогает.
    if (value.replace(/\s+/gu, "") === (profile.telegramChatId ?? "")) { onOpenChange(false); return; }
    setSaving(true);
    setError(null);
    try {
      const saved = await m2Api.setMyTelegramChatId(value);
      toast.success(saved ? "Уведомления CRM будут приходить вам в Telegram" : "Уведомления в Telegram отключены", { title: saved ? "Номер чата сохранён" : "Номер чата убран" });
      onOpenChange(false);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Не получилось сохранить номер чата");
    } finally {
      setSaving(false);
    }
  };

  const loaded = profile.kind === "loaded" ? profile : undefined;
  return (
    <DialogForm
      busy={saving}
      description="Номер чата Telegram вписываете сами: тогда уведомления CRM приходят вам в Telegram."
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
    </DialogForm>
  );
}
