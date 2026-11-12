import React, { useEffect, useState } from "react";
import { m2Api } from "./m2-api.js";
import type { EquipmentFileResponse } from "./types.js";

export const FILE_KIND_LABELS: Readonly<Record<string, string>> = {
  act: "Фото акта",
  photo: "Фото",
  video: "Видео",
  document: "Документ",
  mail_attachment: "Из письма клиента"
};

export function fileSizeLabel(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
  return `${Math.max(1, Math.round(bytes / 1024))} КБ`;
}

function fileType(file: Pick<EquipmentFileResponse, "contentType" | "originalName">): "image" | "video" | "other" {
  const type = file.contentType.toLowerCase();
  if (type.startsWith("image/") || /\.(jpe?g|png|gif|webp|heic|heif|bmp)$/iu.test(file.originalName)) return "image";
  if (type.startsWith("video/") || /\.(mp4|mov|m4v|webm|avi|3gp)$/iu.test(file.originalName)) return "video";
  return "other";
}

function extensionLabel(name: string): string {
  return (/\.([a-z0-9]{1,5})$/iu.exec(name)?.[1] ?? "файл").toUpperCase();
}

/** Превью: если браузер не смог показать фото (например, HEIC в Chrome), остаётся плитка с типом файла. */
function FilePreview({ file, type }: { readonly file: EquipmentFileResponse; readonly type: "image" | "video" | "other" }) {
  const [broken, setBroken] = useState(false);
  if (type === "image" && file.url && !broken) return <img alt="" loading="lazy" onError={() => setBroken(true)} src={file.url} />;
  if (type === "video") return <>{file.url && !broken ? <video muted onError={() => setBroken(true)} preload="metadata" src={`${file.url}#t=0.5`} /> : null}<span className="file-gallery__play">▶</span></>;
  return <span className="file-gallery__ext">{extensionLabel(file.originalName)}</span>;
}

/**
 * Ссылки для файлов, пришедших без ссылки: карточка показывается сразу, а превью
 * подгружаются следом одним запросом (подписанные ссылки сервер хранит в памяти час).
 */
function useFileUrls(files: readonly EquipmentFileResponse[]): ReadonlyMap<string, string> {
  const missing = files.filter((file) => !file.url && file.storageKey).map((file) => file.storageKey as string);
  const signature = missing.join("\n");
  const [urls, setUrls] = useState<ReadonlyMap<string, string>>(new Map());
  useEffect(() => {
    if (!signature) return undefined;
    let current = true;
    void m2Api.signedFileUrls(signature.split("\n")).then((loaded) => {
      if (current) setUrls(loaded);
    }).catch(() => undefined);
    return () => { current = false; };
  }, [signature]);
  return urls;
}

/**
 * Файлы задачи плиткой: у фото превью, у видео кадр и значок, у остального — название.
 * Клик открывает файл целиком в новой вкладке.
 */
export function FileGallery({ files: incoming, emptyText = "Файлов пока нет." }: {
  readonly files: readonly EquipmentFileResponse[];
  readonly emptyText?: string;
}) {
  const urls = useFileUrls(incoming);
  if (incoming.length === 0) return <p className="file-gallery__empty">{emptyText}</p>;
  const files = incoming.map((file) => file.url || !file.storageKey ? file : { ...file, url: urls.get(file.storageKey) });
  return <ul className="file-gallery">
    {files.map((file) => {
      const type = fileType(file);
      const label = FILE_KIND_LABELS[file.kind] ?? "Файл";
      return <li className={`file-gallery__item file-gallery__item--${type}`} key={file.id}>
        <a href={file.url ?? "#"} rel="noreferrer" target="_blank" title={file.originalName}>
          <span className="file-gallery__preview" aria-hidden="true">
            <FilePreview file={file} type={type} />
          </span>
          <span className="file-gallery__caption">
            <strong>{file.originalName}</strong>
            <small>{label} · {fileSizeLabel(file.byteSize)}</small>
          </span>
        </a>
      </li>;
    })}
  </ul>;
}
