#include "peer.hpp"
#include "torrent.hpp"
#include <algorithm>
#include <iostream>
#include <fstream>
#include <openssl/sha.h>
#include <vector>

bool downloadFullFile(PeerConnection &pc, const torrent::TorrentMeta &torrentMeta)
{
    const int pieceLen = torrentMeta.info.pieceLength;
    const int totalLen = torrentMeta.info.length;
    const int numPieces = (totalLen + pieceLen - 1) / pieceLen;
    const int blockSize = 16384; // 16 KiB

    std::ofstream out(torrentMeta.info.name, std::ios::binary);
    if (!out)
    {
        std::cerr << "Cannot open output file\n";
        return false;
    }

    sendInterested(pc.sockfd);
    if (!waitForUnchoke(pc.sockfd))
    {
        std::cerr << "Peer did not unchoke\n";
        return false;
    }

    int downloadedBytes = 0;
    auto printProgress = [&](int currentBytes)
    {
        const int safeTotal = std::max(totalLen, 1);
        const int width = 40;
        const int filled = (currentBytes * width) / safeTotal;
        const int percent = (currentBytes * 100) / safeTotal;

        std::cout << "\r[";
        for (int i = 0; i < width; ++i)
        {
            std::cout << (i < filled ? '#' : '-');
        }
        std::cout << "] " << percent << "% (" << currentBytes << "/" << totalLen << " bytes)" << std::flush;
    };

    printProgress(0);

    for (int pieceIndex = 0; pieceIndex < numPieces; ++pieceIndex)
    {
        int currentPieceLen = std::min(pieceLen, totalLen - pieceIndex * pieceLen);
        std::vector<uint8_t> pieceData(currentPieceLen);

        int offset = 0;
        while (offset < currentPieceLen)
        {
            int reqLen = std::min(blockSize, currentPieceLen - offset);
            sendRequest(pc.sockfd, pieceIndex, offset, reqLen);

            std::vector<uint8_t> block;
            if (!receivePiece(pc.sockfd, block))
            {
                std::cerr << "Failed to receive block for piece " << pieceIndex << " at offset " << offset << std::endl;
                return false;
            }

            std::copy(block.begin(), block.end(), pieceData.begin() + offset);
            offset += static_cast<int>(block.size());
            printProgress(downloadedBytes + offset);
        }

        // Verify hash
        unsigned char hash[20];
        SHA1(pieceData.data(), pieceData.size(), hash);
        std::string actualHash(reinterpret_cast<char *>(hash), 20);
        std::string expectedHash = torrentMeta.info.pieces.substr(pieceIndex * 20, 20);

        if (actualHash != expectedHash)
        {
            std::cerr << "Hash mismatch on piece " << pieceIndex << std::endl;
            return false;
        }

        // Write verified piece to file
        out.write(reinterpret_cast<const char *>(pieceData.data()), pieceData.size());
        downloadedBytes += static_cast<int>(pieceData.size());
        // std::cout << "Downloaded piece " << pieceIndex << "/" << (numPieces - 1) << std::endl;
    }

    printProgress(totalLen);
    std::cout << std::endl;
    std::cout << "\033[32mFile Download complete! \033[0m";
    std::cout << "Saved to " << torrentMeta.info.name << std::endl;
    out.close();
    return true;
}
