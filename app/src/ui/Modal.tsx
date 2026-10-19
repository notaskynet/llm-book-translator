import { useEffect, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const { t } = useTranslation('common');
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-10 flex items-start justify-center overflow-auto bg-black/40 p-4">
      <div role="dialog" aria-modal="true" aria-label={title} className="w-full max-w-2xl space-y-4 rounded-lg bg-white p-4 shadow-lg">
        <div className="flex items-center justify-between">
          <h2 className="font-medium">{title}</h2>
          <button className="rounded border px-2 py-1 text-sm" onClick={onClose}>{t('close')}</button>
        </div>
        {children}
      </div>
    </div>
  );
}
