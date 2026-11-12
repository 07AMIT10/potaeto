import { createClient } from '@/lib/supabase/server';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import Image from 'next/image';

export default async function ContentSharePage({
  params,
}: {
  params: Promise<{ contentId: string }>;
}) {
  const { contentId } = await params;
  const supabase = await createClient();
  const { data: content } = await supabase
    .from('content')
    .select('id, type, public_url, metadata, entity_id')
    .eq('id', contentId)
    .single();

  if (!content) notFound();

  return (
    <main className="min-h-screen max-w-2xl mx-auto px-4 py-8">
      <div className="card p-6 sm:p-8 space-y-4 animate-fade-in">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-[var(--muted)] uppercase tracking-wide">Shared from Potaeto</span>
          <span className="inline-flex rounded-full bg-potato-100 dark:bg-potato-900/30 px-2.5 py-0.5 text-xs font-medium text-potato-700 dark:text-potato-300">
            {content.type}
          </span>
        </div>

        {content.type === 'image' && content.public_url && (
          <div className="space-y-3">
            <Image
              src={content.public_url}
              alt="Shared content"
              width={600}
              height={600}
              className="rounded-xl w-full h-auto"
            />
            <a
              href={content.public_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-potato-600 hover:underline"
            >
              Open full size
            </a>
          </div>
        )}
        {content.type === 'text' && (
          <div className="rounded-xl bg-black/5 dark:bg-white/5 p-4">
            <pre className="whitespace-pre-wrap text-sm leading-relaxed">
              {(content.metadata as { text?: string })?.text ?? 'No text'}
            </pre>
          </div>
        )}
        {(content.type === 'video' || content.type === 'audio') && content.public_url && (
          <a href={content.public_url} target="_blank" rel="noopener noreferrer" className="btn-primary inline-flex">
            Play / download
          </a>
        )}

        <div className="pt-4 border-t border-[var(--card-border)]">
          <Link href="/" className="text-potato-600 hover:underline font-medium text-sm">
            Create your own on Potaeto
          </Link>
        </div>
      </div>
    </main>
  );
}
