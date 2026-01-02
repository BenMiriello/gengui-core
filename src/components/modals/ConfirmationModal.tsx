interface ConfirmationModalProps {
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  onConfirm: () => void;
  onCancel: () => void;
  variant?: 'default' | 'destructive';
}

export default function ConfirmationModal({
  title,
  message,
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  onConfirm,
  onCancel,
  variant = 'default',
}: ConfirmationModalProps) {
  return (
    <div className="fixed inset-0 flex items-center justify-center bg-black bg-opacity-50 z-50">
      <div
        className="w-full max-w-md p-6 rounded shadow-lg"
        style={{
          backgroundColor: 'var(--color-bg-primary)',
          border: '1px solid var(--color-border)',
        }}
      >
        <h2 className="text-xl font-semibold mb-4" style={{ color: 'var(--color-text-primary)' }}>
          {title}
        </h2>

        <p className="mb-6" style={{ color: 'var(--color-text-secondary)' }}>
          {message}
        </p>

        <div className="flex gap-2 justify-end">
          <button
            onClick={onCancel}
            className="px-4 py-2 rounded transition-opacity hover:opacity-70 cursor-pointer"
            style={{
              backgroundColor: 'var(--color-bg-secondary)',
              color: 'var(--color-text-primary)',
            }}
          >
            {cancelText}
          </button>
          <button
            onClick={onConfirm}
            className="px-4 py-2 rounded transition-opacity hover:opacity-70 cursor-pointer"
            style={{
              backgroundColor: variant === 'destructive' ? 'var(--color-error)' : 'var(--color-accent)',
              color: 'var(--color-text-inverse)',
            }}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
