import { useEffect, useState } from 'react';
import { CheckCircle2, GitPullRequest } from 'lucide-react';
import Modal from './Modal';

interface CloseRCAModalProps {
  open: boolean;
  onClose: () => void;
  /** Called with the optional PR URL the user entered (or null to skip). */
  onConfirm: (prUrl: string | null) => void;
  pending?: boolean;
}

const PR_URL_RE = /^(https?:\/\/)[^\s]+$/i;

export default function CloseRCAModal({ open, onClose, onConfirm, pending }: CloseRCAModalProps) {
  const [prUrl, setPrUrl] = useState('');
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (open) {
      setPrUrl('');
      setTouched(false);
    }
  }, [open]);

  const trimmed = prUrl.trim();
  const urlInvalid = trimmed.length > 0 && !PR_URL_RE.test(trimmed);

  const submit = () => {
    if (urlInvalid) {
      setTouched(true);
      return;
    }
    onConfirm(trimmed || null);
  };

  return (
    <Modal open={open} onClose={onClose} size="md" ariaLabel="Close this RCA">
      <div className="p-5">
        <div className="flex items-start gap-3 mb-3">
          <div className="shrink-0 w-10 h-10 rounded-xl bg-emerald-50 ring-1 ring-emerald-100 flex items-center justify-center">
            <CheckCircle2 className="w-5 h-5 text-emerald-600" />
          </div>
          <div className="flex-1 min-w-0 pt-0.5">
            <h3 className="text-base font-semibold text-slate-900 leading-snug">Close this RCA?</h3>
            <p className="text-[13px] text-slate-500 mt-1 leading-relaxed">
              Marking the RCA as <span className="font-medium text-slate-700">Closed</span> means
              the action items have shipped and the issue is fully resolved. The AI summary will
              regenerate if it hasn't already.
            </p>
          </div>
        </div>

        <div className="mt-4">
          <label className="text-[11px] uppercase tracking-[0.08em] text-slate-500 font-semibold flex items-center gap-1.5 mb-1.5">
            <GitPullRequest className="w-3 h-3" />
            Pull request URL <span className="text-slate-400 normal-case font-medium tracking-normal">(optional)</span>
          </label>
          <input
            type="url"
            inputMode="url"
            value={prUrl}
            onChange={(e) => setPrUrl(e.target.value)}
            onBlur={() => setTouched(true)}
            placeholder="https://github.com/your-org/your-repo/pull/123"
            className={`soft-focus w-full px-3 py-2 rounded-lg border text-sm transition-all duration-150 focus:outline-none ${
              touched && urlInvalid
                ? 'border-red-300 bg-red-50/40 focus:border-red-400'
                : 'border-slate-300 focus:border-blue-400'
            }`}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
          />
          {touched && urlInvalid ? (
            <p className="text-xs text-red-500 mt-1">
              Must start with http:// or https://, no spaces.
            </p>
          ) : (
            <p className="text-[11.5px] text-slate-400 mt-1">
              If you fixed this with code, paste the PR link. It'll be appended to the RCA body
              under a <code className="bg-slate-100 px-1 py-0.5 rounded text-[10.5px]">## Pull requests</code> section.
            </p>
          )}
        </div>

        <div className="flex justify-end gap-2 mt-5">
          <button
            type="button"
            onClick={onClose}
            disabled={pending}
            className="bg-white hover:bg-slate-50 text-slate-700 border border-slate-200 rounded-lg px-4 py-2 text-sm font-medium transition-all duration-150 disabled:opacity-50 active:scale-[0.97]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={pending || urlInvalid}
            className="bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg px-4 py-2 text-sm font-medium transition-all duration-150 disabled:opacity-50 inline-flex items-center gap-2 shadow-sm shadow-emerald-500/25 active:scale-[0.97]"
          >
            {pending && (
              <span className="inline-block w-3.5 h-3.5 border-2 border-white/40 border-t-white rounded-full animate-spin" />
            )}
            {pending ? 'Closing…' : 'Close RCA'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
