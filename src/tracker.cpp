#include <string>
#include <vector>
#include <regex>

#include "peer.hpp"
#include "torrent.hpp"

#define CPPHTTPLIB_OPENSSL_SUPPORT
#include "httplib.h"
#include "bencodeParser.hpp"

struct ParsedURL
{
    std::string scheme;
    std::string host;
    std::string path;
};

ParsedURL parse_url(const std::string &url)
{
    std::regex url_regex(R"(^(https?)://([^/]+)(/.*)?$)");
    std::smatch match;

    if (std::regex_match(url, match, url_regex))
    {
        return {
            match[1],
            match[2],
            match[3].matched ? match[3].str() : "/"};
    }
    else
    {
        throw std::invalid_argument("Invalid URL format: " + url);
    }
}

std::vector<Peer> getPeers(torrent::TorrentMeta torrentFile)
{
    std::string trackerUrl = torrentFile.announce;
    std::string infoHash = torrentFile.infoHash;

    std::string peer_id = "-MG0001-123456789012";
    int port = 6881;
    int64_t uploaded = 0;
    int64_t downloaded = 0;
    int64_t left = torrentFile.info.length;

    ParsedURL parsed_url = parse_url(trackerUrl);
    std::string scheme = parsed_url.scheme;

    std::ostringstream query;
    query << "?info_hash=" << infoHash
          << "&peer_id=" << httplib::detail::encode_url(peer_id)
          << "&port=" << port
          << "&uploaded=" << uploaded
          << "&downloaded=" << downloaded
          << "&left=" << left
          << "&compact=1"
          << "&event=started";

    httplib::Result res;
    if (parsed_url.scheme == "https")
    {
        httplib::SSLClient cli(parsed_url.host);
        res = cli.Get(parsed_url.path + query.str());
    }
    else
    {
        httplib::Client cli(parsed_url.host);
        res = cli.Get(parsed_url.path + query.str());
    }

    if (!res)
    {
        throw std::runtime_error("Tracker HTTP request failed: " +
                                 httplib::to_string(res.error()));
    }
    if (res->status != 200)
    {
        throw std::runtime_error("Tracker returned HTTP " +
                                 std::to_string(res->status) +
                                 ": " + res->body);
    }

    // std::cout << res->body << std::endl;

    std::vector<Peer> peers = parsePeerList(res->body);
    return peers;
}
