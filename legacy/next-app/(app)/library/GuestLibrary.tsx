'use client';

import { useEffect, useState } from 'react';
import { LibraryContent } from './LibraryContent';
import { loadGuestEntities, loadGuestContent } from '@/lib/guestStorage';

export function GuestLibrary() {
  const [ready, setReady] = useState(false);
  const [entities, setEntities] = useState(() => [] as ReturnType<typeof loadGuestEntities>);
  const [content, setContent] = useState(() => [] as ReturnType<typeof loadGuestContent>);

  useEffect(() => {
    setEntities(loadGuestEntities());
    setContent(loadGuestContent());
    setReady(true);
  }, []);

  if (!ready) {
    return (
      <div className="card p-8 text-center text-sm text-[var(--muted)]">
        Loading your local content...
      </div>
    );
  }

  if (entities.length === 0 && content.length === 0) {
    return (
      <div className="card p-8 text-center text-sm text-[var(--muted)]">
        No local content yet. Start by creating a character or generating something from the Library.
      </div>
    );
  }

  return <LibraryContent entities={entities} content={content} />;
}

