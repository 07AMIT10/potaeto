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
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800/50 p-6">
        <p className="text-sm text-gray-500 mb-4">Shared from Potaeto</p>
        {content.type === 'image' && content.public_url && (
          <div className="space-y-2">
            <Image
              src={content.public_url}
              alt="Shared content"
              width={600}
              height={600}
              className="rounded-lg w-full h-auto"
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
          <div className="prose dark:prose-invert max-w-none">
            <pre className="whitespace-pre-wrap text-sm">
              {(content.metadata as { text?: string })?.text ?? 'No text'}
            </pre>
          </div>
        )}
        {(content.type === 'video' || content.type === 'audio') && content.public_url && (
          <a href={content.public_url} target="_blank" rel="noopener noreferrer" className="text-potato-600 hover:underline">
            Play / download
          </a>
        )}
        <div className="mt-6 pt-4 border-t border-gray-200 dark:border-gray-700">
          <Link href="/" className="text-potato-600 hover:underline">
            Create your own on Potaeto
          </Link>
        </div>
      </div>
    </main>
  );
}
