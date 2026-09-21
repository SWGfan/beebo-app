package com.beeboentertainment.movie.server

import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody

/**
 * A stand-in for the Beebo computer: an OkHttp client whose interceptor answers from a lambda, so
 * the real request code runs with no network. Records every request it was given.
 */
class FakeServer(private val answer: (Request) -> Pair<Int, String>) {
    val requests = mutableListOf<Request>()
    val bodies = mutableListOf<String>()

    val client: OkHttpClient = OkHttpClient.Builder().addInterceptor(Interceptor { chain ->
        val req = chain.request()
        requests += req
        bodies += req.body?.let { b -> okio.Buffer().also { b.writeTo(it) }.readUtf8() }.orEmpty()
        val (code, body) = answer(req)
        Response.Builder().request(req).protocol(Protocol.HTTP_1_1).code(code).message("test")
            .body(body.toResponseBody("application/json".toMediaType())).build()
    }).build()

    fun json(baseUrl: String? = "https://home.example", token: String? = "tok") = ServerJson({ baseUrl }, { token }, client)
}
