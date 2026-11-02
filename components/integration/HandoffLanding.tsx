'use client';

/**
 * Landing for `/game?handoff=<id>`.
 *
 * The platform has already uploaded the source files and created the handoff;
 * this page fetches the frozen prompt + materials, shows what will be used, and
 * seeds OpenMAIC's existing single-game generation session when the teacher
 * clicks start. Text, embedded images and the PDF layout-page rasters all flow
 * into `pdfText` / `pdfImages`, so the generated game can reference the source.
 */
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft,
  ArrowRight,
  FileText,
  ImageIcon,
  LayoutTemplate,
  LoaderCircle,
} from 'lucide-react';

import { storeHandoffSession } from '@/lib/integration/handoff-client';
import {
  buildHandoffMaterialPreviews,
  buildHandoffGenerationSession,
  summarizeHandoffMaterials,
  type HandoffPayload,
} from '@/lib/integration/handoff-session';

export function HandoffLanding({ handoffId }: { handoffId: string }) {
  const router = useRouter();
  const [payload, setPayload] = useState<HandoffPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/integration/v1/handoffs/${encodeURIComponent(handoffId)}/payload`, {
      cache: 'no-store',
    })
      .then(async (res) => {
        const body = (await res.json()) as {
          handoff?: HandoffPayload['handoff'];
          materials?: HandoffPayload['materials'];
          error?: string;
        };
        if (!res.ok || !body.handoff || !body.materials) {
          throw new Error(body.error || `HTTP ${res.status}`);
        }
        return { handoff: body.handoff, materials: body.materials };
      })
      .then((next) => {
        if (!cancelled) setPayload(next);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [handoffId]);

  const preview = useMemo(
    () =>
      payload
        ? {
            summary: summarizeHandoffMaterials(payload),
            materials: buildHandoffMaterialPreviews(payload),
          }
        : null,
    [payload],
  );

  const start = () => {
    if (!payload || !preview) return;
    setStarting(true);

    const session = buildHandoffGenerationSession(payload);
    sessionStorage.setItem('generationSession', JSON.stringify(session));
    storeHandoffSession(payload.handoff.id, payload.handoff.completionToken);
    router.push('/generation-preview');
  };

  if (error) {
    return (
      <main className="flex min-h-screen items-center justify-center p-6">
        <div className="w-full max-w-lg rounded-lg border border-border bg-card p-6 shadow-sm">
          <h1 className="text-lg font-semibold">链接不可用</h1>
          <p className="mt-2 text-sm text-muted-foreground">{error}</p>
          <p className="mt-4 text-sm text-muted-foreground">可能已过期。请回到平台重新发起生成。</p>
        </div>
      </main>
    );
  }

  if (!payload || !preview) {
    return (
      <main className="flex min-h-screen items-center justify-center p-6">
        <p className="text-sm text-muted-foreground">正在读取素材…</p>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-background px-4 py-8 sm:px-6 sm:py-12">
      <div className="mx-auto w-full max-w-4xl">
        <header>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            轻量化互动资源 · 单游戏
          </p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">确认素材并开始生成</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {payload.materials.length} 个素材 · {preview.summary.chars} 字 ·{' '}
            {preview.summary.images} 张内嵌图
            {preview.summary.layoutPages ? ` · ${preview.summary.layoutPages} 页版式参考` : ''}
          </p>
        </header>

        <section className="mt-6 border-l-2 border-primary/40 pl-4">
          <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            生成要求
          </h2>
          <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-foreground">
            {payload.handoff.prompt}
          </p>
        </section>

        <section className="mt-8" aria-labelledby="material-preview-heading">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div>
              <h2 id="material-preview-heading" className="text-base font-semibold">
                已提取内容
              </h2>
              <p className="mt-1 text-xs text-muted-foreground">
                OpenMAIC 将使用以下正文、图片和版式信息生成单游戏。
              </p>
            </div>
            <p className="text-xs text-muted-foreground">预览图片按需加载</p>
          </div>

          <div className="mt-4 space-y-4">
            {preview.materials.map((material) => (
              <article
                key={material.id}
                className="overflow-hidden rounded-lg border border-border bg-card"
              >
                <header className="flex flex-wrap items-start justify-between gap-2 border-b border-border bg-muted/30 px-4 py-3 sm:px-5">
                  <h3 className="min-w-0 break-words text-sm font-semibold">{material.fileName}</h3>
                  <p className="text-xs text-muted-foreground">
                    {material.textLength} 字
                    {material.embeddedImages.length || material.hiddenEmbeddedImages
                      ? ` · ${material.embeddedImages.length + material.hiddenEmbeddedImages} 图`
                      : ''}
                    {material.layoutPages.length || material.hiddenLayoutPages
                      ? ` · ${material.layoutPages.length + material.hiddenLayoutPages} 页版式`
                      : ''}
                  </p>
                </header>

                <div className="space-y-5 p-4 sm:p-5">
                  <section aria-label={`${material.fileName} 正文摘要`}>
                    <div className="flex items-center gap-2">
                      <FileText className="size-4 text-muted-foreground" aria-hidden="true" />
                      <h4 className="text-xs font-medium text-muted-foreground">正文摘要</h4>
                    </div>
                    {material.textExcerpt ? (
                      <>
                        <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6">
                          {material.textExcerpt}
                        </p>
                        {material.textTruncated ? (
                          <p className="mt-2 text-xs text-muted-foreground">
                            正文共 {material.textLength} 字，此处仅预览开头部分。
                          </p>
                        ) : null}
                      </>
                    ) : (
                      <p className="mt-2 text-sm text-muted-foreground">未提取到正文</p>
                    )}
                  </section>

                  <section aria-label={`${material.fileName} 内嵌图片`}>
                    <div className="flex items-center gap-2">
                      <ImageIcon className="size-4 text-muted-foreground" aria-hidden="true" />
                      <h4 className="text-xs font-medium text-muted-foreground">内嵌图片</h4>
                    </div>
                    {material.embeddedImages.length ? (
                      <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                        {material.embeddedImages.map((image) => (
                          <figure key={image.id} className="min-w-0">
                            <div className="flex h-28 items-center justify-center overflow-hidden rounded-md border border-border bg-muted/40">
                              <img
                                src={image.src}
                                alt={image.label}
                                loading="lazy"
                                decoding="async"
                                referrerPolicy="no-referrer"
                                className="h-full w-full object-contain"
                              />
                            </div>
                            <figcaption className="mt-1 truncate text-xs text-muted-foreground">
                              {image.label}
                            </figcaption>
                          </figure>
                        ))}
                      </div>
                    ) : (
                      <p className="mt-2 text-sm text-muted-foreground">未提取到内嵌图片</p>
                    )}
                    {material.hiddenEmbeddedImages ? (
                      <p className="mt-2 text-xs text-muted-foreground">
                        另有 {material.hiddenEmbeddedImages} 张内嵌图片未展开预览，生成时仍会参考。
                      </p>
                    ) : null}
                  </section>

                  <section aria-label={`${material.fileName} 版式页`}>
                    <div className="flex items-center gap-2">
                      <LayoutTemplate className="size-4 text-muted-foreground" aria-hidden="true" />
                      <h4 className="text-xs font-medium text-muted-foreground">版式页</h4>
                    </div>
                    {material.layoutPages.length ? (
                      <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                        {material.layoutPages.map((page) => (
                          <figure key={page.id} className="min-w-0">
                            <div className="flex h-32 items-center justify-center overflow-hidden rounded-md border border-border bg-muted/40">
                              <img
                                src={page.src}
                                alt={page.label}
                                loading="lazy"
                                decoding="async"
                                referrerPolicy="no-referrer"
                                className="h-full w-full object-contain"
                              />
                            </div>
                            <figcaption className="mt-1 truncate text-xs text-muted-foreground">
                              {page.label}
                            </figcaption>
                          </figure>
                        ))}
                      </div>
                    ) : (
                      <p className="mt-2 text-sm text-muted-foreground">未提取到版式页</p>
                    )}
                    {material.hiddenLayoutPages ? (
                      <p className="mt-2 text-xs text-muted-foreground">
                        另有 {material.hiddenLayoutPages} 页版式未展开预览，生成时仍会参考。
                      </p>
                    ) : null}
                  </section>
                </div>
              </article>
            ))}
          </div>
        </section>

        <p className="mt-5 text-xs leading-5 text-muted-foreground">
          生成时会参考素材中的正文、图片和版式；最终游戏的页面结构与排版由 OpenMAIC 生成。
        </p>

        <div className="mt-6 flex flex-wrap items-center gap-4">
          <button
            type="button"
            onClick={start}
            disabled={starting}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
          >
            {starting ? (
              <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <ArrowRight className="size-4" aria-hidden="true" />
            )}
            {starting ? '正在进入生成…' : '开始生成'}
          </button>
          {payload.handoff.returnUrl ? (
            <a
              href={payload.handoff.returnUrl}
              className="inline-flex items-center gap-1.5 text-sm text-muted-foreground underline-offset-4 hover:underline"
            >
              <ArrowLeft className="size-4" aria-hidden="true" />
              返回平台
            </a>
          ) : null}
        </div>
      </div>
    </main>
  );
}
