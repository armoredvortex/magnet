#include <iostream>
#include <fstream>
#include <sstream>
#include <vector>
#include "bencode.hpp"
#include "bencodeParser.hpp"
#include "torrent.hpp"
#include "tracker.hpp"
#include "peer.hpp"
#include "pieceManager.hpp"
#include "fileWriter.hpp"

int main(int argc, char *argv[])
{
    if (argc < 2)
    {
        std::cerr << "Usage: " << argv[0] << " <filename>" << std::endl;
        return 1;
    }

    std::string filename = argv[1];
    std::ifstream file(filename, std::ios::binary);
    if (!file)
    {
        std::cerr << "Error opening file: " << filename << std::endl;
        return 1;
    }

    std::stringstream buffer;
    buffer << file.rdbuf();
    std::string content = buffer.str();
    file.close();

    torrent::TorrentMeta torrentFile = parseTorrentMeta(content);

    std::vector<Peer> peers;
    try
    {
        peers = getPeers(torrentFile);
    }
    catch (const std::exception &e)
    {
        std::cerr << "Failed to get peers from tracker: " << e.what() << std::endl;
        return 1;
    }

    if (peers.empty())
    {
        std::cerr << "No peers found." << std::endl;
        return 1;
    }
    else
    {
        std::cout << peers.size() << " peer(s) found!" << std::endl;
    }

    // for (const auto &peer : peers)
    // {
    //     std::cout << "Peer IP: " << peer.ip << ", Port: " << peer.port << std::endl;
    // }

    std::vector<PeerConnection> activePeers;
    for (const auto &peer : peers)
    {
        std::cout << "Trying " << peer.ip << ":" << peer.port << std::endl;
        auto sockOpt = connectAndHandshake(peer, torrentFile.infoHashRaw);
        if (sockOpt.has_value())
        {
            std::cout << "\033[32mConnected and handshake successful with \033[0m" << peer.ip << std::endl;

            PeerConnection pc;
            pc.peer = peer;
            pc.sockfd = sockOpt.value();
            activePeers.push_back(std::move(pc));
        }
        else
        {
            std::cerr << "Failed to connect/handshake with " << peer.ip << std::endl;
        }
    }

    if (activePeers.empty())
    {
        std::cerr << "No active peers after connection attempts." << std::endl;
        return 1;
    }
    std::cout << activePeers.size() << " active peer(s) after connection attempts." << std::endl;

    PeerConnection &pc = activePeers[0]; // For simplicity, we use the first active peer
    if (!downloadFullFile(pc, torrentFile))
    {
        std::cerr << "Failed to download the file." << std::endl;
        return 1;
    }
    std::cout << "File downloaded successfully!" << std::endl;
    for (const auto &peer : activePeers)
    {
        close(peer.sockfd);
    }
    std::cout << "All connections closed." << std::endl;
    return 0;
}