import React, { useEffect, useRef, useState, type DragEvent } from "react";
import { Icon, toast } from "./ui.js";

/**
 * Большое поле для фото: перетащить файл или нажать и выбрать. После выбора
 * показывает превью и имя. Внутри обычный input[type=file] с name, поэтому
 * форма читает файл через FormData как раньше.
 */
export function FileDropField({ name, accept, title, hint, disabled = false }: {
  readonly name: string;
  readonly accept: string;
  readonly title: string;
  readonly hint?: string;
  readonly disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (!file || !file.type.startsWith("image/")) { setPreview(null); return undefined; }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  // У HEIC с iPhone браузер часто не знает тип файла: тогда проверяем расширение.
  const EXTENSION_BY_TYPE: Readonly<Record<string, readonly string[]>> = {
    "image/jpeg": ["jpg", "jpeg"], "image/png": ["png"], "image/webp": ["webp"],
    "image/heic": ["heic"], "image/heif": ["heif", "heic"]
  };
  const acceptsFile = (candidate: File) => {
    const extension = /\.([A-Za-z0-9]+)$/u.exec(candidate.name)?.[1]?.toLowerCase();
    return accept.split(",").some((type) => {
      const pattern = type.trim();
      if (!pattern) return false;
      if (pattern.endsWith("/*")) return candidate.type.startsWith(pattern.slice(0, -1)) || (!candidate.type && pattern === "image/*" && Boolean(extension && ["jpg", "jpeg", "png", "webp", "heic", "heif", "gif"].includes(extension)));
      if (candidate.type) return candidate.type === pattern;
      return Boolean(extension && EXTENSION_BY_TYPE[pattern]?.includes(extension));
    });
  };

  useEffect(() => {
    // Файл, отпущенный мимо поля, не должен открыться во вкладке и стереть заполненную форму.
    const guard = (event: globalThis.DragEvent) => { if (event.dataTransfer?.types.includes("Files")) event.preventDefault(); };
    window.addEventListener("dragover", guard);
    window.addEventListener("drop", guard);
    return () => { window.removeEventListener("dragover", guard); window.removeEventListener("drop", guard); };
  }, []);

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    if (disabled) return;
    const dropped = event.dataTransfer.files?.[0];
    if (!dropped || !inputRef.current) return;
    if (!acceptsFile(dropped)) { toast.warning("Этот файл не подходит: нужно фото JPEG, PNG, WebP или HEIC"); return; }
    const transfer = new DataTransfer();
    transfer.items.add(dropped);
    inputRef.current.files = transfer.files;
    setFile(dropped);
  };

  const clear = () => {
    if (inputRef.current) inputRef.current.value = "";
    setFile(null);
  };

  return (
    <div className="file-drop field-wide">
      <span className="file-drop__title">{title}</span>
      {hint ? <small id={`${name}-hint`}>{hint}</small> : null}
      <div
        className={`file-drop__zone${dragging ? " file-drop__zone--active" : ""}${file ? " file-drop__zone--filled" : ""}${disabled ? " file-drop__zone--disabled" : ""}`}
        onDragLeave={() => setDragging(false)}
        onDragOver={(event) => { event.preventDefault(); if (!disabled) setDragging(true); }}
        onDrop={onDrop}
      >
        <input
          accept={accept}
          aria-describedby={hint ? `${name}-hint` : undefined}
          aria-label={title}
          className="file-drop__input"
          disabled={disabled}
          name={name}
          onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          ref={inputRef}
          type="file"
        />
        {file ? (
          <div className="file-drop__selected">
            {preview ? <img alt="" className="file-drop__preview" onError={() => setPreview(null)} src={preview} /> : <span className="file-drop__icon"><Icon name="open" size={22} /></span>}
            <div className="file-drop__meta">
              <strong>{file.name}</strong>
              <span>{(file.size / 1024).toFixed(0)} КБ · нажмите или перетащите, чтобы заменить</span>
            </div>
            <button className="file-drop__clear" onClick={(event) => { event.preventDefault(); clear(); }} type="button">Убрать</button>
          </div>
        ) : (
          <div className="file-drop__empty">
            <span className="file-drop__icon"><Icon name="plus" size={22} /></span>
            <strong>Перетащите фото сюда</strong>
            <span>или нажмите, чтобы выбрать файл на компьютере или снять на телефоне</span>
          </div>
        )}
      </div>
    </div>
  );
}
