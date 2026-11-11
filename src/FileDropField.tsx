import React, { useEffect, useRef, useState, type DragEvent } from "react";
import { Icon, toast } from "./ui.js";

/**
 * Большое поле для фото: перетащить файл или нажать и выбрать. После выбора
 * показывает превью и имя. Внутри обычный input[type=file] с name, поэтому
 * форма читает файл через FormData как раньше.
 */
export function FileDropField({ name, accept, title, hint, disabled = false, multiple = false, emptyTitle, emptyHint }: {
  readonly name: string;
  readonly accept: string;
  readonly title: string;
  readonly hint?: string;
  readonly disabled?: boolean;
  /** Несколько файлов сразу (фото и видео с выезда). */
  readonly multiple?: boolean;
  readonly emptyTitle?: string;
  readonly emptyHint?: string;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [files, setFiles] = useState<readonly File[]>([]);
  const [previews, setPreviews] = useState<readonly (string | null)[]>([]);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const urls = files.map((file) => file.type.startsWith("image/") ? URL.createObjectURL(file) : null);
    setPreviews(urls);
    return () => { for (const url of urls) if (url) URL.revokeObjectURL(url); };
  }, [files]);

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
      if (pattern.startsWith(".")) return extension === pattern.slice(1).toLowerCase();
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

  // Выбранные файлы держим в самом input, чтобы форма читала их через FormData.
  const store = (next: readonly File[]) => {
    if (!inputRef.current) return;
    try {
      const transfer = new DataTransfer();
      for (const file of next) transfer.items.add(file);
      inputRef.current.files = transfer.files;
      setFiles(next);
    } catch {
      // Старый Safari (до iOS 14.5) не умеет собирать список файлов: оставляем то, что выбрал браузер.
      setFiles([...(inputRef.current.files ?? [])]);
    }
  };

  const addFiles = (incoming: readonly File[]) => {
    const fitting = incoming.filter(acceptsFile);
    if (fitting.length < incoming.length) toast.warning(multiple ? "Часть файлов не подходит по типу, их пропустили" : "Этот файл не подходит: нужно фото JPEG, PNG, WebP или HEIC");
    // Ничего не подошло или выбор отменили: возвращаем в поле прежние файлы.
    if (!fitting.length) { store(files); return; }
    store(multiple ? [...files, ...fitting] : fitting.slice(0, 1));
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    if (disabled) return;
    addFiles([...(event.dataTransfer.files ?? [])]);
  };

  const removeAt = (index: number) => store(files.filter((_, fileIndex) => fileIndex !== index));

  return (
    <div className="file-drop field-wide">
      <span className="file-drop__title">{title}</span>
      {hint ? <small id={`${name}-hint`}>{hint}</small> : null}
      <div
        className={`file-drop__zone${dragging ? " file-drop__zone--active" : ""}${files.length ? " file-drop__zone--filled" : ""}${disabled ? " file-drop__zone--disabled" : ""}`}
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
          multiple={multiple}
          name={name}
          onChange={(event) => {
            const picked = [...(event.target.files ?? [])];
            // Повторный выбор в режиме нескольких файлов добавляет к уже выбранным.
            if (multiple) addFiles(picked);
            else if (picked.length) setFiles(picked.slice(0, 1));
            else store(files);
          }}
          ref={inputRef}
          type="file"
        />
        {files.length ? (
          <div className="file-drop__list">
            {files.map((file, index) => <div className="file-drop__selected" key={`${file.name}-${file.size}-${index}`}>
              {previews[index] ? <img alt="" className="file-drop__preview" src={previews[index] ?? undefined} /> : <span className="file-drop__icon"><Icon name="open" size={22} /></span>}
              <div className="file-drop__meta">
                <strong>{file.name}</strong>
                <span>{file.size >= 1024 * 1024 ? `${(file.size / 1024 / 1024).toFixed(1)} МБ` : `${Math.max(1, Math.round(file.size / 1024))} КБ`}{multiple ? "" : " · нажмите или перетащите, чтобы заменить"}</span>
              </div>
              <button className="file-drop__clear" onClick={(event) => { event.preventDefault(); event.stopPropagation(); removeAt(index); }} type="button">Убрать</button>
            </div>)}
            {multiple ? <span className="file-drop__more">Нажмите или перетащите, чтобы добавить ещё</span> : null}
          </div>
        ) : (
          <div className="file-drop__empty">
            <span className="file-drop__icon"><Icon name="plus" size={22} /></span>
            <strong>{emptyTitle ?? (multiple ? "Перетащите файлы сюда" : "Перетащите фото сюда")}</strong>
            <span>{emptyHint ?? (multiple ? "или нажмите, чтобы выбрать несколько файлов или снять на телефоне" : "или нажмите, чтобы выбрать файл на компьютере или снять на телефоне")}</span>
          </div>
        )}
      </div>
    </div>
  );
}
