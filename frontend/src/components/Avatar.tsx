const AVATAR_COLORS = [
  'from-blue-500 to-blue-600',
  'from-violet-500 to-violet-600',
  'from-emerald-500 to-emerald-600',
  'from-amber-500 to-amber-600',
  'from-rose-500 to-rose-600',
  'from-cyan-500 to-cyan-600',
  'from-fuchsia-500 to-fuchsia-600',
  'from-teal-500 to-teal-600',
  'from-orange-500 to-orange-600',
  'from-indigo-500 to-indigo-600',
];

function hashName(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return Math.abs(hash);
}

interface AvatarProps {
  name: string;
  size?: 'xs' | 'sm' | 'md' | 'lg';
  className?: string;
}

const sizeMap = {
  xs: 'w-6 h-6 text-[10px]',
  sm: 'w-8 h-8 text-xs',
  md: 'w-10 h-10 text-sm',
  lg: 'w-12 h-12 text-base',
};

export default function Avatar({ name, size = 'sm', className = '' }: AvatarProps) {
  const safeName = name && name.trim() ? name : '?';
  const colorIndex = hashName(safeName) % AVATAR_COLORS.length;
  const gradient = AVATAR_COLORS[colorIndex];
  const initial = safeName.trim().charAt(0).toUpperCase() || '?';

  return (
    <div
      className={`rounded-full bg-gradient-to-br ${gradient} flex items-center justify-center font-semibold text-white shrink-0 ${sizeMap[size]} ${className}`}
      title={safeName === '?' ? undefined : safeName}
      aria-label={safeName === '?' ? undefined : safeName}
    >
      {initial}
    </div>
  );
}

interface AvatarStackProps {
  names: string[];
  max?: number;
  size?: 'xs' | 'sm' | 'md';
}

export function AvatarStack({ names, max = 3, size = 'sm' }: AvatarStackProps) {
  const shown = names.slice(0, max);
  const remaining = names.length - max;

  const overlapMap = {
    xs: '-ml-1.5',
    sm: '-ml-2',
    md: '-ml-2.5',
  };

  const ringMap = {
    xs: 'ring-1',
    sm: 'ring-2',
    md: 'ring-2',
  };

  return (
    <div className="flex items-center">
      {shown.map((name, i) => (
        <Avatar
          key={name + i}
          name={name}
          size={size}
          className={`${ringMap[size]} ring-white ${i > 0 ? overlapMap[size] : ''}`}
        />
      ))}
      {remaining > 0 && (
        <div
          className={`rounded-full bg-slate-200 flex items-center justify-center font-medium text-slate-600 shrink-0 ${sizeMap[size]} ${overlapMap[size]} ${ringMap[size]} ring-white`}
        >
          +{remaining}
        </div>
      )}
    </div>
  );
}
