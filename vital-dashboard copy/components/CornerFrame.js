export default function CornerFrame({ children, active = false, className = '' }) {
  return (
    <div className={`corner-frame ${active ? 'active' : ''} ${className}`}>
      <span className="corner-bl" />
      <span className="corner-br" />
      {children}
    </div>
  );
}
