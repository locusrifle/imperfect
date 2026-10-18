package computer.imperfect.code

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.MediaStore
import android.webkit.MimeTypeMap
import android.webkit.WebChromeClient

/**
 * What the + in the composer opens.
 *
 * WebView's own `FileChooserParams.createIntent()` reads exactly one thing out
 * of the page: the *first* entry in the field's accept list. imperfect's list
 * starts with the audio wildcard, so the phone opened a sound picker -- no
 * photos, no documents, and no multiple selection either, because that intent
 * drops the field's `multiple` as well. The + looked broken because what it
 * opened could not see anything anybody wanted to attach.
 *
 * So the intent is built here instead, from the whole accept list, and the
 * three ways a phone actually has something to give are offered together:
 * the files already on it, the camera for something in front of it, and the
 * recorder for something being said. None of them is a new surface -- each is
 * the phone's own app, handing back a file the machine then holds.
 */
object Attach {

  /** The chooser the + puts on screen. [photo] is where the camera may write. */
  fun chooser(
    context: Context,
    params: WebChromeClient.FileChooserParams,
    photo: Uri?,
  ): Intent {
    val accept = params.acceptTypes
    val files = documents(params)
    val extras = buildList {
      if (photo != null && admits(accept, "image/jpeg")) {
        add(capture(context, photo))
      }
      if (admits(accept, "audio/mp4")) {
        add(Intent(MediaStore.Audio.Media.RECORD_SOUND_ACTION))
      }
    }.filter { it.resolveActivity(context.packageManager) != null }

    val chooser = Intent.createChooser(files, context.getString(R.string.attach))
    if (extras.isNotEmpty()) {
      chooser.putExtra(Intent.EXTRA_INITIAL_INTENTS, extras.toTypedArray())
    }
    return chooser
  }

  /** The files already on the phone: everything the field accepts, not the first. */
  private fun documents(params: WebChromeClient.FileChooserParams): Intent {
    // GET_CONTENT rather than OPEN_DOCUMENT: it is the action every app that
    // holds content answers, so the sheet lists Photos and Drive beside the
    // file browser, and it is the one a chooser can put other intents next to.
    val intent = Intent(Intent.ACTION_GET_CONTENT)
    intent.addCategory(Intent.CATEGORY_OPENABLE)
    intent.type = "*/*"
    val types = mimeTypes(params.acceptTypes)
    if (types.isNotEmpty()) intent.putExtra(Intent.EXTRA_MIME_TYPES, types)
    // The field says `multiple`; the phone should honour it.
    if (params.mode == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE) {
      intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
    }
    return intent
  }

  private fun capture(context: Context, photo: Uri): Intent {
    val intent = Intent(MediaStore.ACTION_IMAGE_CAPTURE)
    intent.putExtra(MediaStore.EXTRA_OUTPUT, photo)
    // A camera app writes the picture itself, so it needs the grant carried on
    // the intent as well as the per-package one the caller hands out.
    intent.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_READ_URI_PERMISSION)
    grant(context, intent, photo)
    return intent
  }

  private fun grant(context: Context, intent: Intent, uri: Uri) {
    val matches = context.packageManager.queryIntentActivities(intent, PackageManager.MATCH_DEFAULT_ONLY)
    for (match in matches) {
      context.grantUriPermission(
        match.activityInfo.packageName, uri,
        Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_READ_URI_PERMISSION,
      )
    }
  }

  /**
   * The accept list as MIME types a picker understands. Extensions are turned
   * into their type; anything with no known type is dropped rather than passed
   * on, because one unresolvable entry in EXTRA_MIME_TYPES is a picker that
   * shows an empty folder.
   */
  fun mimeTypes(accept: Array<String>?): Array<String> {
    val out = LinkedHashSet<String>()
    for (raw in accept ?: emptyArray()) {
      val token = raw.trim()
      if (token.isEmpty() || token == "*/*") continue
      if (token.contains('/')) { out.add(token); continue }
      val extension = token.removePrefix(".").lowercase()
      val mapped = MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension)
      if (mapped != null) out.add(mapped)
    }
    return out.toTypedArray()
  }

  /**
   * What the picker handed back. `FileChooserParams.parseResult` reads only the
   * intent's single Uri, but a picker opened for several files -- Photos, the
   * system photo picker -- answers with a ClipData list and no Uri at all, even
   * when one image was chosen. Reading only the Uri meant choosing images from
   * the + attached nothing.
   */
  fun chosen(resultCode: Int, data: Intent?): Array<Uri>? {
    if (resultCode != android.app.Activity.RESULT_OK || data == null) return null
    val out = LinkedHashSet<Uri>()
    data.clipData?.let { clip -> for (i in 0 until clip.itemCount) clip.getItemAt(i).uri?.let(out::add) }
    data.data?.let(out::add)
    return out.takeIf { it.isNotEmpty() }?.toTypedArray()
  }

  /** Does the field accept this kind of thing? An empty list accepts anything. */
  fun admits(accept: Array<String>?, mime: String): Boolean {
    val types = mimeTypes(accept)
    if (types.isEmpty()) return true
    val family = mime.substringBefore('/')
    return types.any { it == mime || it == "$family/*" || it == "*/*" }
  }
}
