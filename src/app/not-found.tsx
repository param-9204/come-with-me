export default function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-zinc-950 text-zinc-100">
      <h2 className="text-2xl font-bold mb-4">Not Found</h2>
      <p className="text-zinc-500 mb-6">Could not find requested resource</p>
      <a href="/" className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 rounded-lg font-medium transition-colors">
        Return Home
      </a>
    </div>
  )
}
